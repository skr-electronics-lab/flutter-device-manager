import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  ClientMessage,
  Device,
  FlutterProcessStatus,
  LogEntry,
  LogLevel,
  LogPresetFilter,
  Notification,
  NotificationAction,
  PanelTab,
  RecordingState,
  ReverseForward,
  ServerMessage,
  UiState,
} from "./models/types";
import { AdbService } from "./services/adb";
import { FlutterService } from "./services/flutter";
import { WirelessService } from "./services/wireless";
import { Settings } from "./services/settings";
import { DiscoveryService } from "./services/discovery";
import { DeviceStore } from "./state/deviceStore";
import { LogStore } from "./state/logStore";
import { logger, describeError } from "./utils/logger";
import { uid } from "./utils/io";

type BusyMap = Record<string, string | undefined>;

export interface ControllerDeps {
  adb: AdbService;
  flutter: FlutterService;
  wireless: WirelessService;
  settings: Settings;
  discovery: DiscoveryService;
  store: DeviceStore;
  logs: LogStore;
}

export class PanelController {
  private busy: BusyMap = {};
  private tab: PanelTab = "devices";
  private logFilter: LogLevel | "all" = "all";
  private logPreset: LogPresetFilter = "all";
  private activeForwards: ReverseForward[] = [];
  private notifications: Notification[] = [];
  private flutterStatus: UiState["flutter"] = { status: "idle" };
  private recording: RecordingState | null = null;
  private recordingTimer: NodeJS.Timeout | null = null;
  private projectToolsCollapsed = false;

  private send: (msg: ServerMessage) => void;

  constructor(private deps: ControllerDeps, send: (msg: ServerMessage) => void) {
    this.send = send;
    this.attachSinks();
  }

  private attachSinks(): void {
    const { flutter, logs } = this.deps;
    flutter.setLogSink((level, message) => logs.append(level, "flutter", message));

    // Batched log flush
    logs.onBatch.event((batch: LogEntry[]) => {
      this.send({ type: "logs:appended", entries: batch });
    });

    this.deps.store.onDevicesChanged.event(() => {
      // Record connected devices to history
      for (const d of this.deps.store.all) {
        if (d.state === "connected") {
          void this.deps.settings.addToHistory({
            id: d.id,
            name: d.name || d.transport,
            model: d.model || "",
            brand: d.brand || "",
            transport: d.transport,
            ipAddress: d.ipAddress,
            port: d.port,
            connectionType: d.connectionType || "usb",
            lastConnected: Date.now(),
          });
        }
      }

      // If currently recorded device disconnected mid-recording, stop and attempt pull
      if (this.recording) {
        const stillConnected = this.deps.store.all.some(
          (d) => d.transport === this.recording?.deviceId && d.state === "connected"
        );
        if (!stillConnected) {
          void this.handleDeviceDisconnectDuringRecording(this.recording.deviceId);
        }
      }
      this.sendSnapshot();
    });

    this.deps.store.onMdnsChanged.event(() => this.sendSnapshot());
    this.deps.store.onSelectedChanged.event(() => this.sendSnapshot());
  }

  // --------------------------------------------------------------------------
  // Busy & Notification Management
  // --------------------------------------------------------------------------

  setBusy(key: string, active: boolean, label?: string): void {
    this.busy[key] = active ? label ?? key : undefined;
    this.send({ type: "busy", key, active, label: active ? label : undefined });
  }

  notify(
    message: string,
    level: Notification["level"] = "info",
    actions?: NotificationAction[],
    showVscodeToast = false
  ): void {
    const id = uid("notif");
    const notif: Notification = { id, level, message, actions };
    this.notifications.push(notif);
    this.send({ type: "ui:notify", notification: notif });
    this.deps.logs.append(
      level === "error" ? "error" : level === "warn" ? "warn" : "info",
      "system",
      message
    );

    if (showVscodeToast) {
      if (level === "error") void vscode.window.showErrorMessage(message);
      else if (level === "warn") void vscode.window.showWarningMessage(message);
    }
  }

  dismissNotification(id: string): void {
    this.notifications = this.notifications.filter((n) => n.id !== id);
    this.sendSnapshot();
  }

  // --------------------------------------------------------------------------
  // Message Router
  // --------------------------------------------------------------------------

  async handleMessage(msg: ClientMessage): Promise<void> {
    try {
      await this.route(msg);
    } catch (err) {
      const message = describeError(err);
      logger.error("controller", message);
      this.deps.logs.append("error", "system", message);
      this.notify(message, "error");
    }
  }

  private async route(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "ui:ready":
        this.sendSnapshot();
        break;
      case "ui:setTab":
        this.tab = msg.tab;
        if (msg.tab === "wireless") {
          void this.deps.discovery.scanMdns();
        }
        this.sendSnapshot();
        break;
      case "ui:selectDevice":
        await this.selectDevice(msg.deviceId);
        break;
      case "ui:dismissNotification":
        this.dismissNotification(msg.id);
        break;
      case "ui:toggleProjectTools":
        this.projectToolsCollapsed = msg.collapsed;
        this.sendSnapshot();
        break;
      case "ui:action":
        await this.handleAction(msg.command, msg.payload);
        break;
      case "devices:refresh":
        await this.refreshDevices();
        break;
      case "device:connect":
        await this.connectDevice(msg.deviceId);
        break;
      case "device:disconnect":
        await this.disconnectDevice(msg.deviceId);
        break;
      case "history:connect":
        await this.connectHistoryDevice(msg.id);
        break;
      case "history:remove":
        await this.deps.settings.removeFromHistory(msg.id);
        this.sendSnapshot();
        break;
      case "history:clear":
        await this.deps.settings.clearHistory();
        this.sendSnapshot();
        break;
      case "history:autoConnectAll":
        await this.autoConnectAllHistory();
        break;
      case "adb:restart":
        await this.restartAdb();
        break;
      case "adb:kill":
        await this.killAdb();
        break;
      case "wireless:connect":
        await this.wirelessConnect(msg.transport);
        break;
      case "wireless:pair":
        await this.wirelessPair(msg.host, msg.port, msg.code, msg.connectPort);
        break;
      case "wireless:qrStart":
        await this.wirelessQrStart();
        break;
      case "wireless:qrCancel":
        this.deps.wireless.cancelQrSession();
        break;
      case "wireless:tcpip":
        await this.wirelessTcpip(msg.port);
        break;
      case "wireless:forget":
        await this.wirelessForget(msg.transport);
        break;
      case "wireless:scanMdns":
        await this.deps.discovery.scanMdns();
        this.sendSnapshot();
        break;
      case "flutter:run":
        await this.flutterRun(msg);
        break;
      case "flutter:attach":
        await this.flutterAttach();
        break;
      case "flutter:hotReload":
        await this.flutterHotReload();
        break;
      case "flutter:hotRestart":
        await this.flutterHotRestart();
        break;
      case "flutter:stop":
        await this.flutterStop();
        break;
      case "flutter:clean":
        await this.flutterClean();
        break;
      case "flutter:pubGet":
        await this.flutterPubGet();
        break;
      case "flutter:pubUpgrade":
        await this.flutterPubUpgrade();
        break;
      case "flutter:doctor":
        await this.flutterDoctor();
        break;
      case "flutter:analyze":
        await this.flutterAnalyze();
        break;
      case "flutter:format":
        await this.flutterFormat();
        break;
      case "device:screenshot":
        await this.takeScreenshot();
        break;
      case "device:screenshotClipboard":
        await this.takeScreenshotToClipboard(msg.deviceId);
        break;
      case "device:mirror":
        await this.mirrorScreen(msg.deviceId);
        break;
      case "device:openDeepLink":
        await this.openDeepLink(msg.deviceId, msg.url);
        break;
      case "device:clearAppData":
        await this.clearAppData(msg.deviceId, msg.packageId);
        break;
      case "device:openAppInfo":
        await this.openAppInfo(msg.deviceId, msg.packageId);
        break;
      case "device:toggleWifi":
        await this.toggleWifi(msg.deviceId);
        break;
      case "devices:pruneOffline":
        await this.pruneOffline();
        break;
      case "reverse:list":
        await this.listReverseForwards(msg.deviceId);
        break;
      case "reverse:add":
        await this.addReverseForward(msg.deviceId, msg.port);
        break;
      case "reverse:remove":
        await this.removeReverseForward(msg.deviceId, msg.port);
        break;
      case "reverse:clearAll":
        await this.clearAllReverseForwards(msg.deviceId);
        break;
      case "device:recordToggle":
        await this.toggleScreenRecord();
        break;
      case "device:recordStop":
        await this.stopScreenRecord();
        break;
      case "device:installApk":
        await this.installApk();
        break;
      case "device:uninstall":
        await this.uninstallApp(msg.packageId);
        break;
      case "device:shell":
        await this.openShell();
        break;
      case "device:copyInfo":
        await this.copyDeviceInfo();
        break;
      case "logs:pause":
        this.toggleLogPause(true);
        break;
      case "logs:resume":
        this.toggleLogPause(false);
        break;
      case "logs:clear":
        this.clearLogs();
        break;
      case "logs:copy":
        await this.copyLogs();
        break;
      case "logs:export":
        await this.exportLogs();
        break;
      case "logs:filter":
        this.logFilter = msg.level;
        this.sendSnapshot();
        break;
      case "logs:setPreset":
        this.logPreset = msg.preset;
        this.sendSnapshot();
        break;
    }
  }

  private async handleAction(command: string, payload?: unknown): Promise<void> {
    const data = payload as Record<string, unknown> | undefined;
    switch (command) {
      case "fdm.openFile": {
        const filePath = data?.path as string | undefined;
        if (filePath && fs.existsSync(filePath)) {
          void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
        }
        break;
      }
      case "fdm.revealFile": {
        const filePath = data?.path as string | undefined;
        if (filePath && fs.existsSync(filePath)) {
          void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
        }
        break;
      }
      case "fdm.copyPath": {
        const filePath = data?.path as string | undefined;
        if (filePath) {
          await vscode.env.clipboard.writeText(filePath);
          this.notify("File path copied to clipboard", "info");
        }
        break;
      }
      case "fdm.openExternal": {
        const target = (data?.url as string | undefined) || (data?.path as string | undefined);
        if (target) {
          if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) {
            void vscode.env.openExternal(vscode.Uri.parse(target));
          } else if (fs.existsSync(target)) {
            void vscode.env.openExternal(vscode.Uri.file(target));
          }
        }
        break;
      }
      case "fdm.launchPackage": {
        const serial = data?.serial as string | undefined;
        const packageId = data?.packageId as string | undefined;
        if (serial && packageId) {
          const res = await this.deps.adb.launchPackage(serial, packageId);
          if (res.ok) {
            this.notify(`Launched ${packageId}`, "success");
          } else {
            this.notify(`Launch failed: ${res.message}`, "warn");
          }
        }
        break;
      }
      default:
        logger.warn("controller", `Unknown UI action: ${command}`);
    }
  }

  // --------------------------------------------------------------------------
  // State Snapshot
  // --------------------------------------------------------------------------

  private snapshot(): UiState {
    const tail = this.deps.logs.all.slice(-400);
    return {
      tab: this.tab,
      devices: this.deps.store.all,
      mdns: this.deps.store.mdns,
      mdnsStatus: this.deps.store.mdnsStatus,
      selectedDeviceId: this.deps.store.getSelectedId(),
      flutter: this.flutterStatus,
      logs: tail,
      logFilter: this.logFilter,
      logPreset: this.logPreset,
      logPaused: this.deps.logs.isPaused(),
      busy: this.busy,
      notifications: this.notifications,
      recording: this.recording,
      history: this.deps.settings.getDeviceHistory(),
      activeForwards: this.activeForwards,
      ready: true,
      projectToolsCollapsed: this.projectToolsCollapsed,
    };
  }

  private sendSnapshot(): void {
    this.send({ type: "ui:state", state: this.snapshot() });
  }

  // --------------------------------------------------------------------------
  // Devices & Connectivity
  // --------------------------------------------------------------------------

  private async refreshDevices(): Promise<void> {
    this.setBusy("refresh", true, "Refreshing devices");
    try {
      await this.deps.discovery.refresh();
      if (this.tab === "wireless") {
        await this.deps.discovery.scanMdns();
      }
    } finally {
      this.setBusy("refresh", false);
    }
  }

  private async selectDevice(deviceId: string): Promise<void> {
    this.deps.store.select(deviceId);
    if (this.deps.settings.get().rememberLastDevice) {
      await this.deps.settings.setLastSelectedDevice(deviceId);
    }
    this.sendSnapshot();
  }

  private requireDevice(): Device {
    const device = this.deps.store.selected;
    if (!device) {
      throw new Error("No device selected. Please select a device from the list.");
    }
    if (device.state !== "connected") {
      throw new Error(`Device "${device.name || device.transport}" is not connected.`);
    }
    return device;
  }

  private async connectDevice(deviceId: string): Promise<void> {
    const device = this.deps.store.all.find((d) => d.id === deviceId);
    if (!device) return;
    this.setBusy(`connect:${deviceId}`, true, "Connecting");
    try {
      const result = await this.deps.wireless.connect(device.transport);
      if (result.ok) {
        this.notify(`Connected to ${device.transport}`, "success");
        await this.deps.discovery.refresh();
      } else {
        this.notify(result.error, "error");
      }
    } finally {
      this.setBusy(`connect:${deviceId}`, false);
    }
  }

  private async disconnectDevice(deviceId: string): Promise<void> {
    const device = this.deps.store.all.find((d) => d.id === deviceId);
    if (!device) return;
    this.setBusy(`disconnect:${deviceId}`, true, "Disconnecting");
    try {
      if (device.connectionType === "wireless" || /:\d+$/.test(device.transport)) {
        await this.deps.wireless.disconnect(device.transport);
      }
      this.deps.store.remove(deviceId);
      this.notify(`Disconnected ${device.transport}`, "info");
    } finally {
      this.setBusy(`disconnect:${deviceId}`, false);
    }
  }

  private async restartAdb(): Promise<void> {
    this.setBusy("adb:restart", true, "Restarting ADB");
    try {
      const out = await this.deps.adb.serverRestart();
      this.deps.logs.append("info", "system", `ADB restart: ${out}`);
      this.notify("ADB server restarted", "success");
      await this.deps.discovery.refresh();
    } finally {
      this.setBusy("adb:restart", false);
    }
  }

  private async killAdb(): Promise<void> {
    this.setBusy("adb:kill", true, "Stopping ADB");
    try {
      const out = await this.deps.adb.serverKill();
      this.deps.logs.append("info", "system", `ADB stopped: ${out}`);
      this.notify("ADB server stopped", "info");
      await this.deps.discovery.refresh();
    } finally {
      this.setBusy("adb:kill", false);
    }
  }

  private async wirelessConnect(transport?: string): Promise<void> {
    let target = transport;
    if (!target) {
      const req = await this.deps.wireless.promptConnect();
      if (!req) return;
      target = req.transport;
    }
    this.setBusy("wireless:connect", true, `Connecting ${target}`);
    try {
      const result = await this.deps.wireless.connect(target);
      if (result.ok) {
        this.notify(`Connected to ${target}`, "success");
        await this.deps.discovery.refresh();
        this.sendSnapshot();
      } else {
        this.notify(result.error, "error");
      }
    } finally {
      this.setBusy("wireless:connect", false);
    }
  }

  private async wirelessPair(
    host: string,
    port: number,
    code: string,
    connectPort?: number
  ): Promise<void> {
    this.setBusy("wireless:pair", true, "Pairing & Connecting");
    try {
      const result = await this.deps.wireless.pairWithCode({ host, port, code, connectPort });
      if (result.ok) {
        this.notify(result.message, "success");
        await this.deps.discovery.refresh();
        this.sendSnapshot();
      } else {
        this.notify(result.error, "error");
      }
    } finally {
      this.setBusy("wireless:pair", false);
    }
  }

  private async wirelessQrStart(): Promise<void> {
    if (this.busy["wireless:qr"]) return;
    this.setBusy("wireless:qr", true, "QR Pairing");
    try {
      let session: { payload: string; expiresAt: number };
      try {
        session = this.deps.wireless.beginQrSession();
      } catch (err) {
        this.notify(describeError(err), "error");
        return;
      }
      this.send({ type: "wireless:qr", payload: session.payload, expiresAt: session.expiresAt });
      const result = await this.deps.wireless.awaitQrPairing((phase, message) => {
        this.send({ type: "wireless:qrStatus", phase, message });
      });
      this.send({
        type: "wireless:qrDone",
        ok: result.ok,
        message: result.ok ? result.message : result.error,
      });
      if (result.ok) {
        this.notify(result.message, "success");
        await this.deps.discovery.refresh();
        this.sendSnapshot();
      } else if (result.error !== "QR pairing cancelled.") {
        this.notify(result.error, "error");
      }
    } finally {
      this.setBusy("wireless:qr", false);
    }
  }

  private async wirelessTcpip(port: number): Promise<void> {
    const usb = this.deps.store.all.find(
      (d) => d.connectionType === "usb" && d.state === "connected"
    );
    this.setBusy("wireless:tcpip", true, "Enabling TCP/IP");
    try {
      const result = await this.deps.wireless.enableTcpip(port, usb?.transport);
      if (result.ok) {
        this.notify(result.message, "success");
      } else {
        this.notify(result.error, "error");
      }
    } finally {
      this.setBusy("wireless:tcpip", false);
    }
  }

  private async wirelessForget(transport: string): Promise<void> {
    await this.deps.wireless.forget(transport);
    this.deps.store.remove(transport);
    this.notify(`Forgot ${transport}`, "info");
  }

  // --------------------------------------------------------------------------
  // Flutter Run & Tools
  // --------------------------------------------------------------------------

  private setFlutter(status: FlutterProcessStatus, message?: string): void {
    this.flutterStatus = { status, message };
    this.send({ type: "flutter:progress", status, message });
  }

  private async flutterRun(options: {
    mode: "debug" | "profile" | "release";
    flavor?: string;
    target?: string;
    dartDefine?: string[];
  }): Promise<void> {
    const device = this.requireDevice();
    this.deps.flutter.requireWorkspace();
    if (this.deps.flutter.isRunning) {
      this.notify("A Flutter application is already running. Stop it before starting a new run.", "warn");
      return;
    }
    await this.deps.settings.setLastRunMode(options.mode);

    this.setFlutter("starting", `Building for ${device.name || device.transport}...`);
    this.setBusy("flutter:run", true, `Running (${options.mode})`);

    try {
      await this.deps.flutter.run(
        options,
        device.transport,
        {
          onProgress: (msg) => {
            this.setFlutter("starting", msg);
          },
          onState: (status, msg) => {
            this.setFlutter(status, msg);
          },
          onLine: (line) => {
            this.deps.logs.append("info", "flutter", line);
          },
          onExit: (exitCode) => {
            this.setFlutter("idle");
            this.deps.logs.append(
              exitCode === 0 ? "info" : "warn",
              "flutter",
              `Application stopped (exit code: ${exitCode ?? "none"})`
            );
          },
        }
      );
      this.notify(
        `App running on ${device.name || device.transport} (${options.mode})`,
        "success"
      );
    } finally {
      this.setBusy("flutter:run", false);
    }
  }

  private async flutterAttach(): Promise<void> {
    const device = this.requireDevice();
    this.deps.flutter.requireWorkspace();
    this.setFlutter("starting", `Attaching to ${device.name || device.transport}...`);
    this.setBusy("flutter:attach", true, "Attaching");
    try {
      await this.deps.flutter.attach(device.transport, {
        onState: (status, msg) => this.setFlutter(status, msg),
        onLine: (line) => this.deps.logs.append("info", "flutter", line),
        onExit: () => this.setFlutter("idle"),
      });
      this.notify("Attached to Flutter application", "success");
    } finally {
      this.setBusy("flutter:attach", false);
    }
  }

  private async flutterHotReload(): Promise<void> {
    this.setBusy("flutter:hotReload", true, "Hot reload");
    try {
      await this.deps.flutter.hotReload();
    } finally {
      this.setBusy("flutter:hotReload", false);
    }
  }

  private async flutterHotRestart(): Promise<void> {
    this.setBusy("flutter:hotRestart", true, "Hot restart");
    try {
      await this.deps.flutter.hotRestart();
    } finally {
      this.setBusy("flutter:hotRestart", false);
    }
  }

  private async flutterStop(): Promise<void> {
    this.setBusy("flutter:stop", true, "Stopping");
    try {
      await this.deps.flutter.stop();
      this.setFlutter("idle");
      this.notify("Application stopped", "info");
    } finally {
      this.setBusy("flutter:stop", false);
    }
  }

  private async runProjectCommand(
    key: string,
    label: string,
    runner: (onLine: (l: string) => void) => Promise<{ code: number | null }>
  ): Promise<void> {
    this.deps.flutter.requireWorkspace();
    // Switch to logs tab so output is immediately visible
    this.tab = "logs";
    this.sendSnapshot();

    this.setBusy(key, true, label);
    try {
      const { code } = await runner((line: string) =>
        this.deps.logs.append("info", "flutter", line)
      );
      // For flutter analyze, code 1 is reported issues (not a crash)
      if (code === 0 || (key === "flutter:analyze" && code === 1)) {
        this.notify(`${label} finished`, code === 0 ? "success" : "warn");
      } else {
        this.notify(`${label} failed with exit code ${code}`, "warn");
      }
    } finally {
      this.setBusy(key, false);
    }
  }

  private flutterClean() {
    return this.runProjectCommand("flutter:clean", "flutter clean", (l) =>
      this.deps.flutter.clean(l)
    );
  }

  private flutterPubGet() {
    return this.runProjectCommand("flutter:pubGet", "flutter pub get", (l) =>
      this.deps.flutter.pubGet(l)
    );
  }

  private flutterPubUpgrade() {
    return this.runProjectCommand("flutter:pubUpgrade", "flutter pub upgrade", (l) =>
      this.deps.flutter.pubUpgrade(l)
    );
  }

  private flutterAnalyze() {
    return this.runProjectCommand("flutter:analyze", "flutter analyze", (l) =>
      this.deps.flutter.analyze(l)
    );
  }

  private flutterFormat() {
    return this.runProjectCommand("flutter:format", "dart format .", (l) =>
      this.deps.flutter.format(l)
    );
  }

  private async flutterDoctor(): Promise<void> {
    this.tab = "logs";
    this.sendSnapshot();
    this.setBusy("flutter:doctor", true, "flutter doctor");
    try {
      const { code } = await this.deps.flutter.doctor((line) =>
        this.deps.logs.append("info", "flutter", line)
      );
      if (code === 0) {
        this.notify("Flutter doctor: no issues found", "success");
      } else {
        this.notify("Flutter doctor reported issues", "warn");
      }
    } finally {
      this.setBusy("flutter:doctor", false);
    }
  }

  // --------------------------------------------------------------------------
  // Device History Connections
  // --------------------------------------------------------------------------

  private async connectHistoryDevice(id: string): Promise<void> {
    const item = this.deps.settings.getDeviceHistory().find((d) => d.id === id);
    if (!item) return;

    let target = item.transport;
    this.setBusy(`connect:${id}`, true, `Connecting ${item.name}`);
    try {
      if (item.connectionType === "wireless" || item.ipAddress) {
        const ip = item.ipAddress || (target.includes(":") ? target.split(":")[0] : undefined);
        if (ip) {
          try {
            const services = await this.deps.adb.discoverMdns();
            const conn = services.find(
              (s) => s.type === "connect" && s.target.startsWith(`${ip}:`)
            );
            if (conn) target = conn.target;
          } catch {}
        }
      }
      const result = await this.deps.wireless.connect(target);
      if (result.ok) {
        this.notify(`Connected to ${item.name || target}`, "success");
        await this.deps.discovery.refresh();
      } else {
        this.notify(`Could not connect to ${item.name}: ${result.error}`, "error");
      }
    } finally {
      this.setBusy(`connect:${id}`, false);
    }
  }

  private async autoConnectAllHistory(): Promise<void> {
    const list = this.deps.settings.getDeviceHistory().filter((d) => d.connectionType === "wireless");
    if (list.length === 0) {
      this.notify("No saved wireless devices found in history", "info");
      return;
    }
    this.setBusy("history:autoConnect", true, "Connecting saved devices");
    try {
      await Promise.all(list.map((d) => this.connectHistoryDevice(d.id)));
    } finally {
      this.setBusy("history:autoConnect", false);
    }
  }

  // --------------------------------------------------------------------------
  // Device Actions (Screenshot, Recording, Install, Uninstall, Shell)
  // --------------------------------------------------------------------------

  private async takeScreenshot(): Promise<void> {
    const device = this.requireDevice();
    this.setBusy("device:screenshot", true, "Capturing screenshot");
    try {
      const customDir = this.deps.settings.get().screenshotDir;
      const file = await this.deps.adb.screenshot(device.transport, customDir);
      this.notify(
        `Screenshot saved: ${path.basename(file)}`,
        "success",
        [
          { label: "Open", command: "fdm.openFile", payload: { path: file } },
          { label: "Reveal", command: "fdm.revealFile", payload: { path: file } },
          { label: "Copy Path", command: "fdm.copyPath", payload: { path: file } },
        ]
      );
    } finally {
      this.setBusy("device:screenshot", false);
    }
  }

  private async toggleScreenRecord(): Promise<void> {
    if (this.recording) {
      await this.stopScreenRecord();
    } else {
      await this.startScreenRecord();
    }
  }

  private async startScreenRecord(): Promise<void> {
    const device = this.requireDevice();
    this.setBusy("device:record", true, "Starting recording");
    try {
      await this.deps.adb.startScreenRecord(device.transport, (savedFile) => {
        // Auto-stop timeout callback at 178 seconds
        this.clearRecordingTimer();
        this.recording = null;
        this.send({ type: "recording:tick", recording: null });
        this.notify(
          `Screen recording reached 3-minute limit and was saved: ${path.basename(savedFile)}`,
          "success",
          [
            { label: "Open Video", command: "fdm.openExternal", payload: { path: savedFile } },
            { label: "Reveal", command: "fdm.revealFile", payload: { path: savedFile } },
            { label: "Copy Path", command: "fdm.copyPath", payload: { path: savedFile } },
          ]
        );
      });

      this.recording = { deviceId: device.transport, elapsedSeconds: 0 };
      this.send({ type: "recording:tick", recording: this.recording });

      this.recordingTimer = setInterval(() => {
        if (this.recording) {
          this.recording.elapsedSeconds += 1;
          this.send({ type: "recording:tick", recording: { ...this.recording } });
        }
      }, 1000);

      this.notify(`Recording started on ${device.name || device.transport}`, "info");
    } finally {
      this.setBusy("device:record", false);
    }
  }

  private async stopScreenRecord(): Promise<void> {
    if (!this.recording) return;
    const deviceId = this.recording.deviceId;
    this.clearRecordingTimer();
    this.recording = null;
    this.send({ type: "recording:tick", recording: null });

    this.setBusy("device:record", true, "Finalizing recording");
    try {
      const customDir = this.deps.settings.get().recordingDir;
      const file = await this.deps.adb.stopScreenRecord(deviceId, customDir);
      if (file) {
        this.notify(
          `Recording saved: ${path.basename(file)}`,
          "success",
          [
            { label: "Open Video", command: "fdm.openExternal", payload: { path: file } },
            { label: "Reveal", command: "fdm.revealFile", payload: { path: file } },
            { label: "Copy Path", command: "fdm.copyPath", payload: { path: file } },
          ]
        );
      } else {
        this.notify("Screen recording finished (no file captured)", "warn");
      }
    } finally {
      this.setBusy("device:record", false);
    }
  }

  private clearRecordingTimer(): void {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
  }

  private async handleDeviceDisconnectDuringRecording(deviceId: string): Promise<void> {
    this.clearRecordingTimer();
    this.recording = null;
    this.send({ type: "recording:tick", recording: null });
    try {
      const file = await this.deps.adb.stopScreenRecord(deviceId);
      if (file) {
        this.notify(
          `Device disconnected. Partial recording recovered: ${path.basename(file)}`,
          "warn",
          [
            { label: "Open Video", command: "fdm.openExternal", payload: { path: file } },
            { label: "Reveal", command: "fdm.revealFile", payload: { path: file } },
          ]
        );
      }
    } catch {}
  }

  private async installApk(): Promise<void> {
    const device = this.requireDevice();
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Android Package (.apk)": ["apk"] },
      title: "Select an APK to install",
    });
    if (!picked || picked.length === 0) return;
    const file = picked[0].fsPath;

    this.setBusy("device:installApk", true, `Installing ${path.basename(file)}`);
    try {
      const result = await this.deps.adb.installApk(
        device.transport,
        file,
        (line: string) => this.deps.logs.append("info", "adb", line)
      );

      if (result.ok) {
        this.notify(
          `Installed ${path.basename(file)}`,
          "success"
        );
      } else {
        this.notify(result.message, "error");
      }
    } finally {
      this.setBusy("device:installApk", false);
    }
  }

  private async uninstallApp(presetPackageId?: string): Promise<void> {
    const device = this.requireDevice();
    let target = presetPackageId;

    if (!target) {
      this.setBusy("device:uninstall", true, "Loading packages");
      let packages: string[] = [];
      try {
        packages = await this.deps.adb.listThirdPartyPackages(device.transport);
      } finally {
        this.setBusy("device:uninstall", false);
      }

      if (packages.length > 0) {
        const picked = await vscode.window.showQuickPick(packages, {
          placeHolder: "Select third-party application package to uninstall",
          title: "Uninstall Application",
          matchOnDescription: true,
        });
        if (!picked) return;
        target = picked;
      } else {
        const entered = await vscode.window.showInputBox({
          prompt: "Enter package name to uninstall",
          placeHolder: "com.example.app",
        });
        if (!entered) return;
        target = entered.trim();
      }
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to uninstall ${target}?`,
      { modal: true },
      "Uninstall"
    );
    if (confirm !== "Uninstall") return;

    this.setBusy("device:uninstall", true, `Uninstalling ${target}`);
    try {
      const result = await this.deps.adb.uninstallApp(device.transport, target);
      if (result.ok) {
        this.notify(`Uninstalled ${target}`, "success");
      } else {
        this.notify(result.message, "error");
      }
    } finally {
      this.setBusy("device:uninstall", false);
    }
  }

  private async openShell(): Promise<void> {
    const device = this.requireDevice();
    const adbPath = await this.deps.adb.ensureAdb();
    const terminal = vscode.window.createTerminal({
      name: `ADB Shell (${device.name || device.transport})`,
      shellPath: adbPath,
      shellArgs: ["-s", device.transport, "shell"],
    });
    terminal.show();
  }

  private async copyDeviceInfo(): Promise<void> {
    const device = this.requireDevice();
    const info = [
      `Device Name: ${device.name || "Unknown"}`,
      `Model: ${device.model || "N/A"}`,
      `Brand: ${device.brand || "N/A"}`,
      `Android Version: ${device.androidVersion || "N/A"}${device.apiLevel ? ` (API ${device.apiLevel})` : ""}`,
      `Transport / Serial: ${device.transport}`,
      `Connection Type: ${device.connectionType || "N/A"}`,
      `IP Address: ${device.ipAddress || "N/A"}`,
      `Battery: ${device.batteryLevel != null ? `${device.batteryLevel}%` : "N/A"}`,
      `State: ${device.state}`,
    ].join("\n");

    await vscode.env.clipboard.writeText(info);
    this.notify("Device information copied to clipboard", "info");
  }

  // --------------------------------------------------------------------------
  // Logs
  // --------------------------------------------------------------------------

  private toggleLogPause(paused: boolean): void {
    this.deps.logs.setPaused(paused);
    this.sendSnapshot();
  }

  private clearLogs(): void {
    this.deps.logs.clear();
    this.send({ type: "logs:cleared" });
  }

  private async copyLogs(): Promise<void> {
    const text = this.deps.logs.exportText();
    await vscode.env.clipboard.writeText(text || "(No logs captured)");
    this.notify("Logs copied to clipboard", "info");
  }

  private async exportLogs(): Promise<void> {
    const picked = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(require("os").homedir(), `flutter-device-logs-${Date.now()}.txt`)
      ),
      filters: { "Text Log (.txt)": ["txt", "log"] },
      title: "Export Device Logs",
    });
    if (!picked) return;
    fs.writeFileSync(picked.fsPath, this.deps.logs.exportText(), "utf8");
    this.notify(`Logs exported to ${picked.fsPath}`, "success", [
      { label: "Open", command: "fdm.openFile", payload: { path: picked.fsPath } },
    ]);
  }

  // --------------------------------------------------------------------------
  // Scrcpy Screen Mirroring
  // --------------------------------------------------------------------------

  private async mirrorScreen(deviceId?: string): Promise<void> {
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device) {
      this.notify("Select a device first to mirror screen.", "warn");
      return;
    }
    this.notify(`Launching scrcpy screen mirror for ${device.name}...`, "info");
    const res = await this.deps.adb.launchScrcpy(device.transport);
    if (res.ok) {
      this.notify(res.message, "success");
    } else {
      this.notify(res.message, "error", undefined, true);
    }
  }

  // --------------------------------------------------------------------------
  // Enhanced Screenshot to Clipboard
  // --------------------------------------------------------------------------

  private async takeScreenshotToClipboard(deviceId?: string): Promise<void> {
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device) {
      this.notify("Select a connected device first.", "warn");
      return;
    }
    this.setBusy(`screenshot:${device.id}`, true, "Capturing screenshot");
    try {
      const res = await this.deps.adb.screenshotToClipboard(
        device.transport,
        this.deps.settings.get().screenshotDir
      );
      this.notify(res.message, "success", [
        { label: "Reveal", command: "fdm.revealFile", payload: { path: res.filePath } },
      ]);
    } catch (err) {
      this.notify(`Screenshot failed: ${describeError(err)}`, "error");
    } finally {
      this.setBusy(`screenshot:${device.id}`, false);
    }
  }

  // --------------------------------------------------------------------------
  // Deep Link Intent Dispatcher
  // --------------------------------------------------------------------------

  private async openDeepLink(deviceId?: string, url?: string): Promise<void> {
    if (!url || !url.trim()) {
      this.notify("Please enter a valid URL scheme or link.", "warn");
      return;
    }
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device) {
      this.notify("Select a connected device first.", "warn");
      return;
    }
    this.setBusy(`deeplink:${device.id}`, true, "Dispatching deep link");
    try {
      const res = await this.deps.adb.openDeepLink(device.transport, url.trim());
      if (res.ok) {
        this.notify(res.message, "success");
      } else {
        this.notify(res.message, "warn");
      }
    } catch (err) {
      this.notify(`Deep link error: ${describeError(err)}`, "error");
    } finally {
      this.setBusy(`deeplink:${device.id}`, false);
    }
  }

  // --------------------------------------------------------------------------
  // App Management & Quick Actions
  // --------------------------------------------------------------------------

  private async clearAppData(deviceId?: string, packageId?: string): Promise<void> {
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device) return;

    let targetPkg = packageId;
    if (!targetPkg) {
      const pkgs = await this.deps.adb.listThirdPartyPackages(device.transport);
      if (pkgs.length === 0) {
        this.notify("No 3rd-party apps found on device.", "info");
        return;
      }
      targetPkg = await vscode.window.showQuickPick(pkgs, {
        placeHolder: "Select package to clear app data and cache",
      });
    }
    if (!targetPkg) return;

    this.setBusy(`clear:${device.id}`, true, `Clearing ${targetPkg}`);
    try {
      const res = await this.deps.adb.clearAppData(device.transport, targetPkg);
      if (res.ok) {
        this.notify(`Cleared app data & cache for ${targetPkg}`, "success");
      } else {
        this.notify(res.message, "error");
      }
    } finally {
      this.setBusy(`clear:${device.id}`, false);
    }
  }

  private async openAppInfo(deviceId?: string, packageId?: string): Promise<void> {
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device) return;

    let targetPkg = packageId;
    if (!targetPkg) {
      const pkgs = await this.deps.adb.listThirdPartyPackages(device.transport);
      if (pkgs.length === 0) return;
      targetPkg = await vscode.window.showQuickPick(pkgs, {
        placeHolder: "Select package to open settings details",
      });
    }
    if (!targetPkg) return;

    await this.deps.adb.openAppDetails(device.transport, targetPkg);
    this.notify(`Opened app settings for ${targetPkg}`, "info");
  }

  private async toggleWifi(deviceId?: string): Promise<void> {
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device) return;
    const res = await this.deps.adb.toggleWifi(device.transport);
    this.notify(res.message, res.ok ? "success" : "warn");
  }

  private async pruneOffline(): Promise<void> {
    const count = await this.deps.store.pruneOfflineDevices();
    await this.refreshDevices();
    this.notify(`Disconnected & cleared ${count} offline device socket(s).`, "info");
  }

  // --------------------------------------------------------------------------
  // Reverse Port Forwarding (adb reverse)
  // --------------------------------------------------------------------------

  private async listReverseForwards(deviceId?: string): Promise<void> {
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device || device.state !== "connected") return;
    this.activeForwards = await this.deps.adb.listReverseForwards(device.transport);
    this.send({ type: "reverse:updated", forwards: this.activeForwards });
    this.sendSnapshot();
  }

  private async addReverseForward(deviceId?: string, port?: number): Promise<void> {
    if (!port || isNaN(port)) {
      this.notify("Please specify a valid port number (e.g. 8080).", "warn");
      return;
    }
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device || device.state !== "connected") {
      this.notify("Select a connected device first.", "warn");
      return;
    }
    const res = await this.deps.adb.addReverseForward(device.transport, port);
    this.notify(res.message, res.ok ? "success" : "error");
    await this.listReverseForwards(device.id);
  }

  private async removeReverseForward(deviceId?: string, port?: number): Promise<void> {
    if (!port) return;
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device) return;
    const res = await this.deps.adb.removeReverseForward(device.transport, port);
    this.notify(res.message, res.ok ? "info" : "warn");
    await this.listReverseForwards(device.id);
  }

  private async clearAllReverseForwards(deviceId?: string): Promise<void> {
    const device = deviceId
      ? this.deps.store.all.find((d) => d.id === deviceId)
      : this.deps.store.selected;
    if (!device) return;
    const res = await this.deps.adb.removeAllReverseForwards(device.transport);
    this.notify(res.message, "info");
    await this.listReverseForwards(device.id);
  }
}