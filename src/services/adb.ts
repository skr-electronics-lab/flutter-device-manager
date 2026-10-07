import * as fs from "fs";
import * as path from "path";
import { exec, ExecOptions, spawnTool } from "../utils/process";
import { resolveAdbPath, getDefaultMediaDir, which } from "../utils/paths";
import { logger } from "../utils/logger";
import {
  AdbState,
  ConnectionType,
  Device,
  MdnsService,
  MdnsStatus,
} from "../models/types";

export interface ParsedDeviceLine {
  transport: string;
  state: AdbState;
  product?: string;
  model?: string;
  device?: string;
  usb?: string;
}

const DEVICE_LINE = /^(\S+)\s+(\S+)(?:\s+(.*))?$/;

function parseDeviceLine(line: string): ParsedDeviceLine | null {
  const m = DEVICE_LINE.exec(line.trim());
  if (!m) return null;
  const transport = m[1];
  let state: AdbState = "unknown";
  const rawState = m[2].toLowerCase();
  if (rawState === "device") state = "authorized";
  else if (rawState === "unauthorized") state = "unauthorized";
  else if (rawState === "offline") state = "offline";
  else state = "unknown";

  const props: Record<string, string> = {};
  const rest = m[3] ?? "";
  const re = /([a-z]+):([^\s]+)/g;
  let pm: RegExpExecArray | null;
  while ((pm = re.exec(rest)) !== null) {
    props[pm[1]] = pm[2].replace(/_/g, " ");
  }
  return {
    transport,
    state,
    product: props.product,
    model: props.model,
    device: props.device,
    usb: props.usb,
  };
}

export function connectionTypeOf(transport: string): ConnectionType {
  if (transport.startsWith("emulator-")) return "emulator";
  if (transport.includes("._adb-tls-connect.") || /:\d+$/.test(transport)) return "wireless";
  return "usb";
}

export function parseIpPort(transport: string): { ip: string; port: number } | null {
  const m = /^([^:]+):(\d+)$/.exec(transport);
  if (!m) return null;
  return { ip: m[1], port: Number(m[2]) };
}

export class AdbNotFoundError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "ADB is not installed or could not be located. " +
          "Install Android SDK Platform Tools or configure flutterDeviceManager.adbPath in settings."
    );
    this.name = "AdbNotFoundError";
  }
}

export interface ActiveRecording {
  serial: string;
  remotePath: string;
  startedAt: number;
  timer: NodeJS.Timeout;
}

export class AdbService {
  private adbPath: string | undefined;
  private activeRecordings = new Map<string, ActiveRecording>();

  constructor() {
    this.refreshPath();
  }

  public refreshPath(): void {
    this.adbPath = resolveAdbPath();
  }

  async ensureAdb(): Promise<string> {
    if (!this.adbPath) {
      throw new AdbNotFoundError();
    }
    return this.adbPath;
  }

  get isAvailable(): boolean {
    return !!this.adbPath;
  }

  private run(
    args: string[],
    options: ExecOptions = {},
    serial?: string
  ): ReturnType<typeof exec> {
    return this.ensureAdb().then((adb) => {
      const full = serial ? ["-s", serial, ...args] : args;
      return exec(adb, full, options);
    });
  }

  /** Checks mDNS daemon availability and status without swallowing errors. */
  async checkMdns(): Promise<MdnsStatus> {
    try {
      const adb = await this.ensureAdb();
      const res = await exec(adb, ["mdns", "check"], { timeoutMs: 5000 });
      const out = (res.stdout + res.stderr).trim();
      const lower = out.toLowerCase();
      const available =
        res.code === 0 &&
        !lower.includes("error") &&
        !lower.includes("not available") &&
        !lower.includes("disabled");
      return {
        available,
        message: out || (available ? "mDNS is active" : "mDNS is unavailable"),
      };
    } catch (err) {
      return {
        available: false,
        message: `mDNS check error: ${String(err)}`,
      };
    }
  }

  /** Discovers active wireless debugging endpoints via mDNS. */
  async discoverMdns(): Promise<MdnsService[]> {
    try {
      const adb = await this.ensureAdb();
      const res = await exec(adb, ["mdns", "services"], { timeoutMs: 5000 });
      const services: MdnsService[] = [];
      for (const line of res.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("List of")) continue;
        const m = /^(.*?)\s+(_adb-tls-(pairing|connect)\._tcp\.?)\s+([a-zA-Z0-9\.\-:]+)$/.exec(
          trimmed
        );
        if (m) {
          services.push({
            name: m[1].trim(),
            type: m[3] as "pairing" | "connect",
            target: m[4].trim(),
          });
        }
      }
      return services;
    } catch {
      return [];
    }
  }

  /** Parses `adb devices -l` */
  async listDevicesRaw(): Promise<ParsedDeviceLine[]> {
    const adb = await this.ensureAdb();
    const result = await exec(adb, ["devices", "-l"]);
    const rows: ParsedDeviceLine[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/^List of devices attached/i.test(line)) continue;
      if (line.startsWith("*")) continue;
      const parsed = parseDeviceLine(line);
      if (parsed) rows.push(parsed);
    }
    return rows;
  }

  /**
   * Probes device properties, Wi-Fi IP, and battery level in a SINGLE `adb shell` execution.
   * Uses explicit key-value prefixes so missing/empty getprop values never shift array indices.
   */
  async probeDevice(transport: string): Promise<Partial<Device>> {
    const script = [
      "echo '===PROP==='",
      "echo \"marketname:$(getprop ro.product.marketname)\"",
      "echo \"config_marketname:$(getprop ro.config.marketing_name)\"",
      "echo \"manufacturer:$(getprop ro.product.manufacturer)\"",
      "echo \"brand:$(getprop ro.product.brand)\"",
      "echo \"model:$(getprop ro.product.model)\"",
      "echo \"release:$(getprop ro.build.version.release)\"",
      "echo \"sdk:$(getprop ro.build.version.sdk)\"",
      "echo \"name:$(getprop ro.product.name)\"",
      "echo '===IP==='",
      "ip -4 addr show wlan0 2>/dev/null || ip route 2>/dev/null",
      "echo '===BATT==='",
      "dumpsys battery 2>/dev/null",
    ].join(" && ");

    const info: Partial<Device> = {};

    try {
      const res = await this.run(["shell", script], { timeoutMs: 8000 }, transport);
      if (res.code === 0 && res.stdout) {
        const out = res.stdout;
        const parts = out.split(/===(?:PROP|IP|BATT)===/);

        // parts[1]: props key-value mapping
        if (parts[1]) {
          const props: Record<string, string> = {};
          for (const line of parts[1].split(/\r?\n/)) {
            const trimmed = line.trim();
            const colonIdx = trimmed.indexOf(":");
            if (colonIdx > 0) {
              const k = trimmed.slice(0, colonIdx).trim();
              const v = trimmed.slice(colonIdx + 1).trim();
              if (v) props[k] = v;
            }
          }

          const marketName = props.marketname || "";
          const configMarketName = props.config_marketname || "";
          const manufacturer = props.manufacturer || "";
          const brand = props.brand || manufacturer;
          const model = props.model || "";
          const release = props.release || "";
          const sdk = props.sdk || "";
          const codename = props.name || "";

          // Capitalize helper
          const cap = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";

          // Clean display name resolution
          let displayName = "";
          if (marketName && !marketName.includes("[")) {
            displayName = marketName;
          } else if (configMarketName && !configMarketName.includes("[")) {
            displayName = configMarketName;
          } else if (brand || model) {
            const b = cap(brand);
            if (model && b && model.toLowerCase().startsWith(b.toLowerCase())) {
              displayName = model;
            } else if (b && model) {
              displayName = `${b} ${model}`;
            } else {
              displayName = model || b;
            }
          } else if (codename) {
            displayName = codename;
          }

          if (displayName) info.name = displayName;
          if (model) info.model = model;
          if (brand) info.brand = cap(brand);
          if (release) info.androidVersion = release;
          if (sdk) {
            const api = Number.parseInt(sdk, 10);
            if (!Number.isNaN(api)) info.apiLevel = api;
          }
        }

        if (parts[2]) {
          const m = /(?:inet\s+|src\s+)(\d{1,3}(?:\.\d{1,3}){3})/.exec(parts[2]);
          if (m && m[1] !== "127.0.0.1") {
            info.ipAddress = m[1];
          }
        }

        if (parts[3]) {
          const m = /level:\s*(\d+)/i.exec(parts[3]);
          if (m) {
            const level = Number(m[1]);
            info.batteryLevel = level > 100 ? 100 : Math.max(0, level);
          }
        }
      }
    } catch (err) {
      logger.warn("adb", `Combined probe failed for ${transport}: ${String(err)}`);
    }

    return info;
  }

  // --------------------------------------------------------------------------
  // Connectivity
  // --------------------------------------------------------------------------

  connect(transport: string, timeoutMs = 12_000): Promise<{ ok: boolean; message: string }> {
    return this.ensureAdb()
      .then((adb) => exec(adb, ["connect", transport], { timeoutMs }))
      .then((r) => {
        const out = (r.stdout + r.stderr).trim();
        const ok = /^(already )?connected to /im.test(out);
        return { ok, message: out };
      });
  }

  disconnect(transport: string): Promise<{ ok: boolean; message: string }> {
    return this.ensureAdb()
      .then((adb) => exec(adb, ["disconnect", transport], { timeoutMs: 8000 }))
      .then((r) => {
        const out = (r.stdout + r.stderr).trim();
        return { ok: r.code === 0, message: out };
      });
  }

  pair(host: string, port: number, code: string): Promise<{ ok: boolean; message: string }> {
    return this.ensureAdb()
      .then((adb) => exec(adb, ["pair", `${host}:${port}`, code], { timeoutMs: 15_000 }))
      .then((r) => {
        const out = (r.stdout + r.stderr).trim();
        const ok = /successfully paired/i.test(out);
        return { ok, message: out || "Pairing failed." };
      });
  }

  tcpip(port: number, usbSerial?: string): Promise<{ ok: boolean; message: string }> {
    const args = usbSerial
      ? ["-s", usbSerial, "tcpip", String(port)]
      : ["-d", "tcpip", String(port)];
    return this.ensureAdb()
      .then((adb) => exec(adb, args, { timeoutMs: 15_000 }))
      .then((r) => {
        const out = (r.stdout + r.stderr).trim();
        return { ok: r.code === 0, message: out };
      });
  }

  serverRestart(): Promise<string> {
    return this.ensureAdb()
      .then((adb) => exec(adb, ["kill-server"], { timeoutMs: 10_000 }))
      .then(() => this.ensureAdb())
      .then((adb) => exec(adb, ["start-server"], { timeoutMs: 15_000 }))
      .then((r) => (r.stdout + r.stderr).trim());
  }

  serverKill(): Promise<string> {
    return this.ensureAdb()
      .then((adb) => exec(adb, ["kill-server"], { timeoutMs: 10_000 }))
      .then((r) => (r.stdout + r.stderr).trim());
  }

  // --------------------------------------------------------------------------
  // Device actions
  // --------------------------------------------------------------------------

  /** Captures a screenshot into a file, awaiting stream completion and deleting partials on error. */
  async screenshot(serial: string, customDir?: string): Promise<string> {
    const adb = await this.ensureAdb();
    const dir = customDir && customDir.trim() ? customDir.trim() : getDefaultMediaDir("Screenshots");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const cleanSerial = serial.replace(/[^a-zA-Z0-9.-]/g, "_");
    const filename = `screenshot-${cleanSerial}-${Date.now()}.png`;
    const destFile = path.join(dir, filename);

    await new Promise<void>((resolve, reject) => {
      const child = spawnTool(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const outStream = fs.createWriteStream(destFile);

      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.stdout?.pipe(outStream);

      outStream.on("finish", () => {
        if (child.exitCode === 0 || child.exitCode === null) {
          resolve();
        } else {
          cleanupPartial();
          reject(new Error(`Screenshot failed with exit code ${child.exitCode}: ${stderr}`));
        }
      });

      const cleanupPartial = () => {
        try {
          if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
        } catch {}
      };

      outStream.on("error", (err) => {
        cleanupPartial();
        reject(err);
      });

      child.on("error", (err) => {
        cleanupPartial();
        reject(err);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          cleanupPartial();
          reject(new Error(`Screenshot process exited with code ${code}: ${stderr}`));
        }
      });
    });

    return destFile;
  }

  /**
   * Starts a real background screen recording without fixed duration.
   * Auto-stops when 180s Android hardware limit is approached.
   */
  async startScreenRecord(
    serial: string,
    onTimeout: (savedFile: string) => void
  ): Promise<void> {
    if (this.activeRecordings.has(serial)) {
      throw new Error("A screen recording is already in progress on this device.");
    }
    const adb = await this.ensureAdb();
    const remote = `/sdcard/fdm_record_${Date.now()}.mp4`;

    // Spawn screenrecord on device
    spawnTool(adb, ["-s", serial, "shell", "screenrecord", remote], {
      stdio: "ignore",
    });

    const timer = setTimeout(async () => {
      try {
        const file = await this.stopScreenRecord(serial);
        if (file) onTimeout(file);
      } catch (err) {
        logger.error("adb", `auto-stop recording failed: ${String(err)}`);
      }
    }, 178_000); // 178s to be safely within 180s Android hard limit

    this.activeRecordings.set(serial, {
      serial,
      remotePath: remote,
      startedAt: Date.now(),
      timer,
    });
  }

  isRecording(serial: string): boolean {
    return this.activeRecordings.has(serial);
  }

  getActiveRecording(serial: string): ActiveRecording | undefined {
    return this.activeRecordings.get(serial);
  }

  /** Stops recording, sends SIGINT, pulls MP4 file, and removes remote artifact. */
  async stopScreenRecord(serial: string, customDir?: string): Promise<string | null> {
    const active = this.activeRecordings.get(serial);
    if (!active) return null;

    clearTimeout(active.timer);
    this.activeRecordings.delete(serial);

    try {
      // Send SIGINT to screenrecord on the device so it finalizes MP4 headers
      await this.run(
        [
          "shell",
          "pkill -SIGINT screenrecord 2>/dev/null || kill -2 $(pidof screenrecord) 2>/dev/null",
        ],
        { timeoutMs: 6000 },
        serial
      );
    } catch {
      /* process may have already exited */
    }

    // Wait a brief moment for the video file header to be closed
    await new Promise((r) => setTimeout(r, 1200));

    const dir = customDir && customDir.trim() ? customDir.trim() : getDefaultMediaDir("Recordings");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const localFile = path.join(
      dir,
      `recording-${serial.replace(/[^a-zA-Z0-9.-]/g, "_")}-${Date.now()}.mp4`
    );

    // Pull video
    await this.run(["pull", active.remotePath, localFile], { timeoutMs: 120_000 }, serial);

    // Remove remote file
    try {
      await this.run(["shell", "rm", "-f", active.remotePath], { timeoutMs: 5000 }, serial);
    } catch {}

    return localFile;
  }

  /** Installs APK with readable error translations. */
  async installApk(
    serial: string,
    apkPath: string,
    onLine?: (line: string) => void
  ): Promise<{ ok: boolean; message: string; packageId?: string }> {
    const res = await this.run(
      ["install", "-r", "-t", apkPath],
      { timeoutMs: 240_000, onStdout: onLine, onStderr: onLine },
      serial
    );
    const out = (res.stdout + res.stderr).trim();
    const ok = res.code === 0 && /Success/i.test(out);

    if (ok) {
      return { ok: true, message: "APK installed successfully." };
    }

    // Parse Android failure code
    const failMatch = /Failure\s+\[(.*?)\]/i.exec(out);
    if (failMatch) {
      const code = failMatch[1];
      const friendlyMap: Record<string, string> = {
        INSTALL_FAILED_ALREADY_EXISTS: "Application is already installed.",
        INSTALL_FAILED_INVALID_APK: "The APK is invalid or corrupted.",
        INSTALL_FAILED_INSUFFICIENT_STORAGE: "Insufficient storage space on the device.",
        INSTALL_FAILED_DUPLICATE_PERMISSION: "Application defines a duplicate permission.",
        INSTALL_FAILED_UPDATE_INCOMPATIBLE: "Update incompatible: signature doesn't match the installed version.",
        INSTALL_FAILED_OLDER_SDK: "APK requires a newer Android version than this device supports.",
        INSTALL_FAILED_USER_RESTRICTED: "Installation restricted by device policy or user settings.",
        INSTALL_FAILED_VERSION_DOWNGRADE: "Cannot downgrade from a newer installed version.",
      };
      const hint = friendlyMap[code] ?? code;
      return { ok: false, message: `Install failed: ${hint}` };
    }

    return { ok: false, message: out || "APK installation failed." };
  }

  /** Queries installed 3rd-party packages (pm list packages -3). */
  async listThirdPartyPackages(serial: string): Promise<string[]> {
    try {
      const res = await this.run(["shell", "pm", "list", "packages", "-3"], { timeoutMs: 10_000 }, serial);
      if (res.code !== 0) return [];
      return res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("package:"))
        .map((line) => line.replace(/^package:/, ""))
        .sort();
    } catch {
      return [];
    }
  }

  async uninstallApp(serial: string, packageId: string): Promise<{ ok: boolean; message: string }> {
    const res = await this.run(["uninstall", packageId], { timeoutMs: 30_000 }, serial);
    const out = (res.stdout + res.stderr).trim();
    const ok = res.code === 0 && /Success/i.test(out);
    return { ok, message: out || (ok ? `Uninstalled ${packageId}` : "Uninstall failed.") };
  }

  async launchPackage(serial: string, packageId: string): Promise<{ ok: boolean; message: string }> {
    const res = await this.run(
      ["shell", "monkey", "-p", packageId, "-c", "android.intent.category.LAUNCHER", "1"],
      { timeoutMs: 15_000 },
      serial
    );
    const out = (res.stdout + res.stderr).trim();
    return { ok: res.code === 0, message: out };
  }

  /**
   * Launches scrcpy screen mirroring for the given device.
   * Checks common paths and standard system PATH.
   */
  async launchScrcpy(serial: string): Promise<{ ok: boolean; message: string }> {
    const candidates = [
      "scrcpy",
      "scrcpy.exe",
      "C:\\ProgramData\\chocolatey\\bin\\scrcpy.exe",
      path.join(process.env.USERPROFILE || "", "scoop", "shims", "scrcpy.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "scrcpy", "scrcpy.exe"),
    ];

    let foundPath: string | null = null;
    for (const c of candidates) {
      if (path.isAbsolute(c)) {
        if (fs.existsSync(c)) {
          foundPath = c;
          break;
        }
      } else {
        const p = which(c);
        if (p) {
          foundPath = p;
          break;
        }
      }
    }

    if (!foundPath) {
      return {
        ok: false,
        message:
          "scrcpy executable not found. Please install scrcpy ('choco install scrcpy' or 'scoop install scrcpy') and add it to your PATH.",
      };
    }

    try {
      const child = spawnTool(
        foundPath,
        ["-s", serial, "--window-title", `Flutter Device [${serial}]`, "--always-on-top"],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
      return { ok: true, message: `Mirroring started with scrcpy for ${serial}.` };
    } catch (err) {
      return { ok: false, message: `Failed to launch scrcpy: ${String(err)}` };
    }
  }

  /**
   * Queries active adb reverse port forwardings on the device.
   */
  async listReverseForwards(serial: string): Promise<Array<{ host: number; device: number }>> {
    try {
      const res = await this.run(["reverse", "--list"], { timeoutMs: 8000 }, serial);
      if (res.code !== 0 || !res.stdout) return [];
      const list: Array<{ host: number; device: number }> = [];
      const lines = res.stdout.split(/\r?\n/);
      for (const line of lines) {
        // Output format: <serial> tcp:<remotePort> tcp:<localPort>
        const m = /tcp:(\d+)\s+tcp:(\d+)/i.exec(line);
        if (m) {
          list.push({ device: Number(m[1]), host: Number(m[2]) });
        }
      }
      return list;
    } catch {
      return [];
    }
  }

  /**
   * Adds an adb reverse port forwarding (device localhost:port -> host localhost:port).
   */
  async addReverseForward(serial: string, port: number): Promise<{ ok: boolean; message: string }> {
    const res = await this.run(["reverse", `tcp:${port}`, `tcp:${port}`], { timeoutMs: 10_000 }, serial);
    const out = (res.stdout + res.stderr).trim();
    const ok = res.code === 0;
    return { ok, message: ok ? `Reversed tcp:${port} -> tcp:${port}` : out || "Failed to reverse port." };
  }

  /**
   * Removes an adb reverse port forwarding.
   */
  async removeReverseForward(serial: string, port: number): Promise<{ ok: boolean; message: string }> {
    const res = await this.run(["reverse", "--remove", `tcp:${port}`], { timeoutMs: 10_000 }, serial);
    const out = (res.stdout + res.stderr).trim();
    const ok = res.code === 0;
    return { ok, message: ok ? `Removed reverse tcp:${port}` : out || "Failed to remove reverse port." };
  }

  /**
   * Removes all adb reverse port forwardings on the device.
   */
  async removeAllReverseForwards(serial: string): Promise<{ ok: boolean; message: string }> {
    const res = await this.run(["reverse", "--remove-all"], { timeoutMs: 10_000 }, serial);
    const out = (res.stdout + res.stderr).trim();
    const ok = res.code === 0;
    return { ok, message: ok ? "All reverse port forwards removed." : out || "Failed to remove all reverse ports." };
  }

  /**
   * Dispatches an Android VIEW Intent for deep link testing.
   */
  async openDeepLink(serial: string, url: string): Promise<{ ok: boolean; message: string }> {
    const cleanUrl = url.trim();
    if (!cleanUrl) return { ok: false, message: "URL cannot be empty." };
    const res = await this.run(
      ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", cleanUrl],
      { timeoutMs: 15_000 },
      serial
    );
    const out = (res.stdout + res.stderr).trim();
    const ok = res.code === 0 && !/Error:/i.test(out);
    return { ok, message: ok ? `Dispatched deep link: ${cleanUrl}` : out || "Failed to open deep link." };
  }

  /**
   * Clears app user data and cache (adb shell pm clear <pkg>).
   */
  async clearAppData(serial: string, packageId: string): Promise<{ ok: boolean; message: string }> {
    const res = await this.run(["shell", "pm", "clear", packageId], { timeoutMs: 15_000 }, serial);
    const out = (res.stdout + res.stderr).trim();
    const ok = res.code === 0 && /Success/i.test(out);
    return { ok, message: ok ? `Cleared data for ${packageId}` : out || "Failed to clear app data." };
  }

  /**
   * Opens Application Info settings page for the package on the device.
   */
  async openAppInfo(serial: string, packageId: string): Promise<{ ok: boolean; message: string }> {
    const res = await this.run(
      ["shell", "am", "start", "-a", "android.settings.APPLICATION_DETAILS_SETTINGS", "-d", `package:${packageId}`],
      { timeoutMs: 15_000 },
      serial
    );
    const out = (res.stdout + res.stderr).trim();
    const ok = res.code === 0 && !/Error:/i.test(out);
    return { ok, message: ok ? `Opened app details for ${packageId}` : out || "Failed to open app info." };
  }

  async openAppDetails(serial: string, packageId: string): Promise<{ ok: boolean; message: string }> {
    return this.openAppInfo(serial, packageId);
  }

  /**
   * Toggles Wi-Fi on the device via adb shell.
   */
  async toggleWifi(serial: string): Promise<{ ok: boolean; message: string }> {
    try {
      // Check current state via dumpsys or cmd
      const checkRes = await this.run(["shell", "dumpsys", "wifi"], { timeoutMs: 6000 }, serial);
      const isEnabled = /Wi-Fi is enabled/i.test(checkRes.stdout) || /mWifiEnabled=true/i.test(checkRes.stdout);
      const newState = isEnabled ? "disable" : "enable";
      const toggleRes = await this.run(["shell", "svc", "wifi", newState], { timeoutMs: 8000 }, serial);
      return {
        ok: toggleRes.code === 0,
        message: toggleRes.code === 0 ? `Wi-Fi turned ${newState}d.` : "Failed to toggle Wi-Fi.",
      };
    } catch (err) {
      return { ok: false, message: `Wi-Fi toggle error: ${String(err)}` };
    }
  }

  /**
   * Captures a screenshot and copies it directly to OS clipboard.
   */
  async screenshotToClipboard(serial: string, customDir?: string): Promise<{ ok: boolean; message: string; filePath: string }> {
    const filePath = await this.screenshot(serial, customDir);
    try {
      if (process.platform === "win32") {
        // Use PowerShell to put image on Windows clipboard
        const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${filePath.replace(/'/g, "''")}')); Set-Clipboard -Path '${filePath.replace(/'/g, "''")}'`;
        await spawnTool("powershell", ["-NoProfile", "-Command", script]);
      }
      return { ok: true, message: `Screenshot copied to clipboard & saved: ${path.basename(filePath)}`, filePath };
    } catch {
      return { ok: true, message: `Screenshot saved: ${path.basename(filePath)}`, filePath };
    }
  }
}

let adbSingleton: AdbService | null = null;
export function getAdb(): AdbService {
  if (!adbSingleton) adbSingleton = new AdbService();
  return adbSingleton;
}