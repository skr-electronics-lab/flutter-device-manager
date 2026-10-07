/**
 * Domain models and protocol contracts for Flutter Device Manager.
 * Strict TypeScript types with zero `any`.
 */

export type AdbState = "authorized" | "unauthorized" | "offline" | "unknown";
export type DeviceState =
  | "connected"
  | "disconnected"
  | "unauthorized"
  | "offline"
  | "pairing"
  | "unknown";

export type ConnectionType = "usb" | "wireless" | "emulator";

export interface Device {
  /** Unique stable identifier for this device in the UI. */
  id: string;
  /** Transport or serial used with `adb -s <transport>`. */
  transport: string;
  name: string;
  model: string;
  brand: string;
  androidVersion: string;
  apiLevel: number | null;
  connectionType: ConnectionType;
  ipAddress?: string;
  port?: number;
  adbState: AdbState;
  state: DeviceState;
  batteryLevel: number | null;
  isEmulator: boolean;
  isRemembered: boolean;
  lastSeen: number;
}

export interface MdnsService {
  name: string;
  serviceType?: "_adb-tls-pairing._tcp" | "_adb-tls-connect._tcp" | string;
  type?: string;
  target: string;
  host?: string;
  port?: number;
  ipAddress?: string;
  attributes?: Record<string, string>;
  discoveredAt?: number;
}

export interface MdnsStatus {
  available: boolean;
  message: string;
  backend?: "zeroconf" | "dns-sd" | "adb-mdns" | "none";
}

export type PanelTab = "devices" | "wireless" | "logs";

export type LogLevel = "verbose" | "debug" | "info" | "warn" | "error";

export type LogPresetFilter = "all" | "flutter" | "crashes" | "network";

export interface ReverseForward {
  host: number;
  device: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  tag?: string;
  message: string;
  pid?: number;
  tid?: number;
  raw?: string;
  source?: string;
  count?: number;
}

export type FlutterProcessStatus =
  | "idle"
  | "starting"
  | "running"
  | "attaching"
  | "stopping"
  | "error";

export interface FlutterRunState {
  status: FlutterProcessStatus;
  mode?: "debug" | "profile" | "release";
  targetDevice?: string;
  appName?: string;
  observatoryUri?: string;
  pid?: number;
  hotReloadAvailable?: boolean;
  hotRestartAvailable?: boolean;
  message?: string;
}

export interface NotificationAction {
  label: string;
  command: string;
  payload?: unknown;
}

export interface Notification {
  id: string;
  type?: "info" | "success" | "warn" | "error";
  level?: "info" | "success" | "warn" | "error";
  message: string;
  timestamp?: number;
  dismissible?: boolean;
  action?: NotificationAction;
  actions?: NotificationAction[];
}

export type QrPhase = "idle" | "starting" | "waiting" | "pairing" | "connecting" | "done" | "error";

export interface RecordingState {
  deviceId: string;
  serial?: string;
  startedAt?: number;
  elapsedSeconds: number;
  remotePath?: string;
}

export interface DeviceHistoryItem {
  id: string;
  name: string;
  model: string;
  brand: string;
  transport: string;
  ipAddress?: string;
  port?: number;
  connectionType: ConnectionType;
  lastConnected: number;
}

export interface UiState {
  tab: PanelTab;
  devices: Device[];
  mdns: MdnsService[];
  mdnsStatus?: MdnsStatus;
  selectedDeviceId?: string;
  flutter: FlutterRunState;
  logs: LogEntry[];
  logFilter: LogLevel | "all";
  logPreset?: LogPresetFilter;
  logPaused: boolean;
  /** Map of operation keys to their active display labels (when busy). */
  busy: Record<string, string | undefined>;
  notifications: Notification[];
  recording: RecordingState | null;
  history: DeviceHistoryItem[];
  activeForwards?: ReverseForward[];
  ready: boolean;
  projectToolsCollapsed?: boolean;
}

export type FlutterRunOptions = {
  mode: "debug" | "profile" | "release";
  flavor?: string;
  target?: string;
  dartDefine?: string[];
};

/** Messages flowing from the webview to the extension host. */
export type ClientMessage =
  | { type: "ui:ready" }
  | { type: "ui:setTab"; tab: PanelTab }
  | { type: "ui:selectDevice"; deviceId: string }
  | { type: "ui:action"; command: string; payload?: unknown }
  | { type: "ui:dismissNotification"; id: string }
  | { type: "ui:toggleProjectTools"; collapsed: boolean }
  | { type: "devices:refresh" }
  | { type: "devices:pruneOffline" }
  | { type: "device:connect"; deviceId: string }
  | { type: "device:disconnect"; deviceId: string }
  | { type: "device:mirror"; deviceId?: string }
  | { type: "device:screenshot" }
  | { type: "device:screenshotClipboard"; deviceId?: string }
  | { type: "device:recordToggle" }
  | { type: "device:recordStop" }
  | { type: "device:installApk" }
  | { type: "device:uninstall"; packageId?: string }
  | { type: "device:clearAppData"; deviceId?: string; packageId?: string }
  | { type: "device:openAppInfo"; deviceId?: string; packageId?: string }
  | { type: "device:toggleWifi"; deviceId?: string }
  | { type: "device:openDeepLink"; deviceId?: string; url: string }
  | { type: "device:shell" }
  | { type: "device:copyInfo" }
  | { type: "reverse:list"; deviceId?: string }
  | { type: "reverse:add"; deviceId?: string; port: number }
  | { type: "reverse:remove"; deviceId?: string; port: number }
  | { type: "reverse:clearAll"; deviceId?: string }
  | { type: "history:connect"; id: string }
  | { type: "history:remove"; id: string }
  | { type: "history:clear" }
  | { type: "history:autoConnectAll" }
  | { type: "adb:restart" }
  | { type: "adb:kill" }
  | { type: "wireless:connect"; transport?: string }
  | { type: "wireless:pair"; host: string; port: number; code: string; connectPort?: number }
  | { type: "wireless:qrStart" }
  | { type: "wireless:qrCancel" }
  | { type: "wireless:tcpip"; port: number }
  | { type: "wireless:forget"; transport: string }
  | { type: "wireless:scanMdns" }
  | { type: "flutter:run"; mode: "debug" | "profile" | "release"; flavor?: string; target?: string; dartDefine?: string[] }
  | { type: "flutter:attach" }
  | { type: "flutter:hotReload" }
  | { type: "flutter:hotRestart" }
  | { type: "flutter:stop" }
  | { type: "flutter:clean" }
  | { type: "flutter:pubGet" }
  | { type: "flutter:pubUpgrade" }
  | { type: "flutter:doctor" }
  | { type: "flutter:analyze" }
  | { type: "flutter:format" }
  | { type: "logs:pause" }
  | { type: "logs:resume" }
  | { type: "logs:clear" }
  | { type: "logs:copy" }
  | { type: "logs:export" }
  | { type: "logs:filter"; level: LogLevel | "all" }
  | { type: "logs:setPreset"; preset: LogPresetFilter };

/** Messages flowing from the extension host to the webview. */
export type ServerMessage =
  | { type: "ui:state"; state: UiState }
  | { type: "ui:notify"; notification: Notification }
  | { type: "busy"; key: string; active: boolean; label?: string }
  | { type: "logs:appended"; entries: LogEntry[] }
  | { type: "logs:cleared" }
  | { type: "flutter:progress"; status: FlutterProcessStatus; message?: string }
  | { type: "wireless:code"; host: string; port: number }
  | { type: "wireless:qr"; payload: string; expiresAt: number }
  | { type: "wireless:qrStatus"; phase: QrPhase; message: string }
  | { type: "wireless:qrDone"; ok: boolean; message: string }
  | { type: "reverse:updated"; forwards: ReverseForward[] }
  | { type: "recording:tick"; recording: RecordingState | null };