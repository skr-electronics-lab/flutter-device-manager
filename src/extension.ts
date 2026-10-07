import * as vscode from "vscode";
import { SidebarView } from "./ui/panel";
import { ControllerDeps } from "./controller";
import { Settings } from "./services/settings";
import { DeviceStore } from "./state/deviceStore";
import { LogStore } from "./state/logStore";
import { getAdb, AdbService } from "./services/adb";
import { getFlutter, FlutterService } from "./services/flutter";
import { WirelessService } from "./services/wireless";
import { DiscoveryService } from "./services/discovery";
import { registerCommands } from "./commands";
import { initLogger, logger, setLoggerSink } from "./utils/logger";

let sidebar: SidebarView | undefined;
let discovery: DiscoveryService | undefined;
let deps: ControllerDeps;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger("Flutter Device Manager");

  const logs = new LogStore();
  setLoggerSink((level, message) => logs.append(level, "system", message));

  const settings = new Settings(context);
  const adb: AdbService = getAdb();
  const flutter: FlutterService = getFlutter((level, message) =>
    logs.append(level, "flutter", message)
  );
  const store = new DeviceStore(adb);
  const wireless = new WirelessService(adb, settings);
  discovery = new DiscoveryService(store, logs, settings, wireless, adb);

  deps = { adb, flutter, wireless, settings, discovery, store, logs };

  sidebar = new SidebarView(context, deps);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarView.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push({ dispose: () => discovery?.dispose() });

  registerCommands(context, sidebar);

  // Background refresh + saved device selection restore, independent of the view.
  void discovery.start().then(() => restoreLastSelection());

  // Keep theme and tool discovery in sync on configuration changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("flutterDeviceManager")) {
        deps.adb.refreshPath();
        deps.flutter.refreshPath();
        void discovery?.refresh();
      }
    })
  );

  logger.info("extension", "activated");
}

function restoreLastSelection(): void {
  const settings = deps.settings;
  if (!settings.get().rememberLastDevice) return;
  const last = settings.getLastSelectedDevice();
  const store = deps.store;
  if (last && store.all.some((d) => d.id === last)) {
    store.select(last);
  } else {
    const firstConnected = store.all.find((d) => d.state === "connected");
    store.select(firstConnected?.id);
  }
}

export function deactivate(): void {
  discovery?.dispose();
}