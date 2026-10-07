import "./styles.css";
import QRCode from "qrcode";
import {
  ClientMessage,
  Device,
  DeviceHistoryItem,
  LogEntry,
  LogLevel,
  LogPresetFilter,
  Notification,
  PanelTab,
  QrPhase,
  RecordingState,
  ReverseForward,
  ServerMessage,
  UiState,
} from "../models/types";
import { el, append, clear, icon, text, fmtTime, fmtSeconds } from "./dom";
import { renderDeviceCard } from "./components/deviceCard";
import {
  ICON_REFRESH,
  ICON_PLAY,
  ICON_ATTACH,
  ICON_LIGHTNING,
  ICON_RESTART,
  ICON_STOP,
  ICON_CAMERA,
  ICON_RECORD,
  ICON_APK,
  ICON_TRASH,
  ICON_TERMINAL,
  ICON_COPY,
  ICON_BROOM,
  ICON_DOWNLOAD,
  ICON_SHIELD,
  ICON_WIFI,
  ICON_USB,
  ICON_QR,
  ICON_KEY,
  ICON_POWER,
  ICON_LINK,
  ICON_PHONE,
  ICON_CHEVRON_DOWN,
  ICON_CHEVRON_RIGHT,
  ICON_MORE,
  ICON_CLOSE,
  ICON_CHECK,
  ICON_INFO,
  ICON_WARNING,
  ICON_ERROR,
  ICON_KOFI,
  ICON_EXTERNAL,
  ICON_HEART,
} from "./icons";

declare function acquireVsCodeApi(): {
  postMessage(message: ClientMessage): void;
};
const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// App State
// ---------------------------------------------------------------------------

interface QrViewState {
  payload: string;
  expiresAt: number;
  phase: QrPhase;
  message: string;
}

interface AppState {
  tab: PanelTab;
  devices: Device[];
  history: DeviceHistoryItem[];
  mdns: import("../models/types").MdnsService[];
  mdnsStatus?: import("../models/types").MdnsStatus;
  selectedDeviceId?: string;
  flutter: UiState["flutter"];
  logs: LogEntry[];
  logFilter: LogLevel | "all";
  logPreset: LogPresetFilter;
  autoScrollLogs: boolean;
  reversePortInput: string;
  deepLinkInput: string;
  activeForwards: ReverseForward[];
  logPaused: boolean;
  busy: Record<string, string | undefined>;
  notifications: Notification[];
  recording: RecordingState | null;
  ready: boolean;
  runMode: "debug" | "profile" | "release";
  logSearch: string;
  qr: QrViewState | null;
  collapsed: {
    project: boolean;
    details: boolean;
    history: boolean;
    advancedWireless: boolean;
  };
  moreProjectMenuOpen: boolean;
  moreRunMenuOpen: boolean;
  moreLogsMenuOpen: boolean;
}

const state: AppState = {
  tab: "devices",
  devices: [],
  history: [],
  mdns: [],
  flutter: { status: "idle" },
  logs: [],
  logFilter: "all",
  logPreset: "all",
  autoScrollLogs: true,
  reversePortInput: "",
  deepLinkInput: "",
  activeForwards: [],
  logPaused: false,
  busy: {},
  notifications: [],
  recording: null,
  ready: false,
  runMode: "debug",
  logSearch: "",
  qr: null,
  collapsed: {
    project: false,
    details: true,
    history: false,
    advancedWireless: true,
  },
  moreProjectMenuOpen: false,
  moreRunMenuOpen: false,
  moreLogsMenuOpen: false,
};

let qrDataUrl = "";
let qrCountdownTimer: NodeJS.Timeout | null = null;

async function generateQrDataUrl(payload: string): Promise<string> {
  try {
    return await QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      width: 190,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch {
    return "";
  }
}

function startQrCountdown(): void {
  stopQrCountdown();
  qrCountdownTimer = setInterval(() => {
    if (!state.qr) {
      stopQrCountdown();
      return;
    }
    const remaining = Math.max(0, Math.ceil((state.qr.expiresAt - Date.now()) / 1000));
    const countdownEl = document.getElementById("qr-countdown-status");
    if (countdownEl) {
      if (remaining > 0) {
        countdownEl.textContent = `Waiting for phone to scan QR (${remaining}s remaining)...`;
      } else {
        countdownEl.textContent = "QR code session expired. Please cancel and generate a new one.";
        stopQrCountdown();
      }
    }
  }, 1000);
}

function stopQrCountdown(): void {
  if (qrCountdownTimer) {
    clearInterval(qrCountdownTimer);
    qrCountdownTimer = null;
  }
}

function formatTimeAgo(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

const isBusy = (key: string): boolean => !!state.busy[key];
const getSelectedDevice = (): Device | undefined =>
  state.devices.find((d) => d.id === state.selectedDeviceId);

// ---------------------------------------------------------------------------
// Form inputs preserved across renders
// ---------------------------------------------------------------------------

const forms = {
  directAddress: "",
  pairIp: "",
  pairPort: "",
  pairCode: "",
  pairConnectPort: "",
  tcpipPort: "5555",
};

// ---------------------------------------------------------------------------
// Main Rendering Engine
// ---------------------------------------------------------------------------

let appEl: HTMLElement;

function initApp(): void {
  appEl = document.getElementById("app") || document.body;
  vscode.postMessage({ type: "ui:ready" });
  renderApp();
}

function renderApp(): void {
  clear(appEl);

  const header = renderHeader();
  const tabBar = renderTabBar();
  const content = renderContent();
  const toasts = renderToasts();

  append(appEl, header, tabBar, content, toasts);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(): HTMLElement {
  const connectedCount = state.devices.filter((d) => d.state === "connected").length;

  const countPill = el(
    "span",
    {
      class: `count-pill${connectedCount > 0 ? " has-connected" : ""}`,
      title: `${connectedCount} connected device(s)`,
    },
    `${connectedCount} connected`
  );

  const refreshBtn = el(
    "button",
    {
      class: "btn-ghost btn-icon-only",
      title: "Refresh Devices",
      disabled: isBusy("refresh"),
      "aria-label": "Refresh Devices",
    },
    icon(ICON_REFRESH)
  );
  refreshBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "devices:refresh" });
  });

  const restartAdbBtn = el(
    "button",
    {
      class: "btn-ghost btn-icon-only",
      title: "Restart ADB Server",
      disabled: isBusy("adb:restart"),
      "aria-label": "Restart ADB Server",
    },
    icon(ICON_POWER)
  );
  restartAdbBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "adb:restart" });
  });

  const header = el(
    "header",
    { class: "panel-header" },
    el(
      "div",
      { class: "header-title-row" },
      el("span", { class: "header-title" }, "Flutter Device Manager"),
      countPill
    ),
    el("div", { class: "header-actions" }, refreshBtn, restartAdbBtn)
  );

  return header;
}

// ---------------------------------------------------------------------------
// Tab Bar
// ---------------------------------------------------------------------------

function renderTabBar(): HTMLElement {
  const tabs: Array<{ id: PanelTab; label: string }> = [
    { id: "devices", label: "Devices" },
    { id: "wireless", label: "Wireless" },
    { id: "logs", label: "Logs" },
  ];

  const bar = el("nav", { class: "tab-bar", role: "tablist" });

  for (const t of tabs) {
    const active = state.tab === t.id;
    const btn = el(
      "button",
      {
        class: `tab-btn${active ? " active" : ""}`,
        role: "tab",
        "aria-selected": active ? "true" : "false",
      },
      text(t.label)
    );
    btn.addEventListener("click", () => {
      if (state.tab !== t.id) {
        state.tab = t.id;
        vscode.postMessage({ type: "ui:setTab", tab: t.id });
        renderApp();
      }
    });
    bar.appendChild(btn);
  }

  return bar;
}

// ---------------------------------------------------------------------------
// Tab Contents Router
// ---------------------------------------------------------------------------

function renderContent(): HTMLElement {
  const container = el("main", { class: "tab-content", role: "tabpanel" });

  switch (state.tab) {
    case "devices":
      renderDevicesTab(container);
      break;
    case "wireless":
      renderWirelessTab(container);
      break;
    case "logs":
      renderLogsTab(container);
      break;
  }

  // Support / Ko-fi footer displayed cleanly at the bottom
  if (state.tab !== "logs") {
    container.appendChild(renderSupportFooter());
  }

  return container;
}

// ---------------------------------------------------------------------------
// Devices Tab
// ---------------------------------------------------------------------------

function renderDevicesTab(parent: HTMLElement): void {
  // 1. Sticky Run Bar
  parent.appendChild(renderStickyRunBar());

  // 2. Separate Live Connected vs Offline Devices
  const connected = state.devices.filter((d) => d.state === "connected");
  const offline = state.devices.filter((d) => d.state !== "connected");

  const devicesList = el("div", { class: "devices-list" });

  if (connected.length === 0 && offline.length === 0) {
    const emptyBox = el(
      "div",
      { class: "empty-state-box" },
      el("div", { class: "empty-state-title" }, "No Android devices connected"),
      el(
        "div",
        { class: "empty-state-description" },
        "Connect a phone via USB or pair wirelessly."
      ),
      el(
        "div",
        { class: "empty-state-steps" },
        text("1. Enable Developer Options on phone"),
        el("br"),
        text("2. Enable USB / Wireless Debugging"),
        el("br"),
        text("3. Unlock screen and accept connection prompt")
      ),
      el(
        "button",
        {
          class: "btn-secondary btn-sm",
          disabled: isBusy("refresh"),
        },
        icon(ICON_REFRESH),
        text("Refresh Devices")
      )
    );
    emptyBox.querySelector("button")?.addEventListener("click", () => {
      vscode.postMessage({ type: "devices:refresh" });
    });
    devicesList.appendChild(emptyBox);
  } else {
    // Render active connected devices
    for (const d of connected) {
      const card = renderDeviceCard(d, d.id === state.selectedDeviceId, {
        onSelect: (id) => {
          state.selectedDeviceId = id;
          vscode.postMessage({ type: "ui:selectDevice", deviceId: id });
          renderApp();
        },
        onConnect: (id) => {
          vscode.postMessage({ type: "device:connect", deviceId: id });
        },
        onDisconnect: (id) => {
          vscode.postMessage({ type: "device:disconnect", deviceId: id });
        },
        onMirror: (id) => {
          vscode.postMessage({ type: "device:mirror", deviceId: id });
        },
        busyKey: (k) => isBusy(k),
      });
      devicesList.appendChild(card);
    }
  }

  parent.appendChild(devicesList);

  // 3. Selected Device Actions & Collapsible Details
  const selected = getSelectedDevice();
  if (selected && selected.state === "connected") {
    parent.appendChild(renderSelectedDevicePanel(selected));
  }

  // 4. Offline / Disconnected Devices Section (pruned of duplicates)
  if (offline.length > 0) {
    const offlineSec = el("div", { class: "collapsible-section", style: "margin-top: 4px;" });
    const offlineHeader = el(
      "div",
      {
        style: "display: flex; align-items: center; justify-content: space-between; padding: 4px 2px;",
      },
      el("span", { class: "section-label" }, `Offline / Disconnected (${offline.length})`),
      el(
        "button",
        {
          class: "btn-ghost btn-sm danger-hover",
          title: "Disconnect all offline device sockets from ADB",
        },
        text("Clear Offline")
      )
    );
    offlineHeader.querySelector("button")?.addEventListener("click", () => {
      vscode.postMessage({ type: "devices:pruneOffline" });
    });
    offlineSec.appendChild(offlineHeader);

    const offlineList = el("div", { class: "devices-list", style: "gap: 6px;" });
    for (const d of offline) {
      const card = renderDeviceCard(d, false, {
        onSelect: (id) => {
          state.selectedDeviceId = id;
          vscode.postMessage({ type: "ui:selectDevice", deviceId: id });
          renderApp();
        },
        onConnect: (id) => {
          vscode.postMessage({ type: "device:connect", deviceId: id });
        },
        onDisconnect: (id) => {
          vscode.postMessage({ type: "device:disconnect", deviceId: id });
        },
        busyKey: (k) => isBusy(k),
      });
      offlineList.appendChild(card);
    }
    offlineSec.appendChild(offlineList);
    parent.appendChild(offlineSec);
  }

  // 5. Device History Section
  const historySec = renderDeviceHistorySection();
  if (historySec) parent.appendChild(historySec);

  // 6. Project Tools
  parent.appendChild(renderProjectToolsSection());
}

function renderStickyRunBar(): HTMLElement {
  const bar = el("div", { class: "sticky-run-bar" });
  const connectedDevices = state.devices.filter((d) => d.state === "connected");

  const deviceSelect = el("select", { class: "device-select" });
  if (connectedDevices.length === 0) {
    const opt = el("option", { value: "" }, "No device connected");
    deviceSelect.appendChild(opt);
    deviceSelect.disabled = true;
  } else {
    for (const d of connectedDevices) {
      const opt = el(
        "option",
        { value: d.id, selected: d.id === state.selectedDeviceId },
        d.name || d.transport
      );
      deviceSelect.appendChild(opt);
    }
    deviceSelect.addEventListener("change", (e) => {
      const target = (e.target as HTMLSelectElement).value;
      state.selectedDeviceId = target;
      vscode.postMessage({ type: "ui:selectDevice", deviceId: target });
      renderApp();
    });
  }

  const modeSelect = el("select", { class: "mode-select" });
  const modes: Array<"debug" | "profile" | "release"> = ["debug", "profile", "release"];
  for (const m of modes) {
    const opt = el("option", { value: m, selected: state.runMode === m }, m);
    modeSelect.appendChild(opt);
  }
  modeSelect.addEventListener("change", (e) => {
    state.runMode = (e.target as HTMLSelectElement).value as "debug" | "profile" | "release";
  });

  const isRunning = state.flutter.status === "running";
  const isStarting = state.flutter.status === "starting";
  const isStopping = state.flutter.status === "stopping";
  const active = isRunning || isStarting;

  const runBtn = el(
    "button",
    {
      class: "btn-primary run-btn-main",
      disabled: active || connectedDevices.length === 0 || isBusy("flutter:run"),
      title: `Run flutter on selected device (${state.runMode})`,
    },
    icon(ICON_PLAY),
    text(isStarting ? "Building" : "Run")
  );
  runBtn.addEventListener("click", () => {
    state.tab = "logs";
    renderApp();
    vscode.postMessage({ type: "flutter:run", mode: state.runMode });
  });

  const topRow = el("div", { class: "run-controls-row" }, deviceSelect, modeSelect, runBtn);
  bar.appendChild(topRow);

  if (active || isStopping) {
    const statusRow = el("div", { class: "running-controls-row" });
    const statusMsg = state.flutter.message || (isStarting ? "Building..." : "Running");

    const statusIndicator = el(
      "div",
      { class: "run-status-indicator", title: statusMsg },
      icon(isStarting ? ICON_REFRESH : ICON_PLAY),
      text(statusMsg)
    );

    const reloadBtn = el(
      "button",
      {
        class: "btn-secondary btn-sm",
        disabled: !isRunning || isBusy("flutter:hotReload"),
        title: "Hot Reload (r)",
      },
      icon(ICON_LIGHTNING),
      text("Reload")
    );
    reloadBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "flutter:hotReload" });
    });

    const restartBtn = el(
      "button",
      {
        class: "btn-secondary btn-sm",
        disabled: !isRunning || isBusy("flutter:hotRestart"),
        title: "Hot Restart (R)",
      },
      icon(ICON_RESTART),
      text("Restart")
    );
    restartBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "flutter:hotRestart" });
    });

    const stopBtn = el(
      "button",
      {
        class: "btn-ghost btn-sm danger-hover",
        disabled: isStopping || isBusy("flutter:stop"),
        title: "Stop Application (q)",
      },
      icon(ICON_STOP),
      text("Stop")
    );
    stopBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "flutter:stop" });
    });

    const attachBtn = el(
      "button",
      {
        class: "btn-ghost btn-icon-only",
        title: "Flutter Attach",
        disabled: isRunning || isStarting,
      },
      icon(ICON_ATTACH)
    );
    attachBtn.addEventListener("click", () => {
      state.tab = "logs";
      renderApp();
      vscode.postMessage({ type: "flutter:attach" });
    });

    const actionsGroup = el(
      "div",
      { class: "run-actions-group" },
      reloadBtn,
      restartBtn,
      stopBtn,
      attachBtn
    );

    append(statusRow, statusIndicator, actionsGroup);
    bar.appendChild(statusRow);
  }

  return bar;
}

function renderSelectedDevicePanel(device: Device): HTMLElement {
  const panel = el("div", { class: "selected-device-actions-panel" });

  const isRec = state.recording && state.recording.deviceId === device.transport;
  const recTime = isRec ? fmtSeconds(state.recording!.elapsedSeconds) : "";

  // 1. Prominent Mirror Button
  const mirrorBtn = el(
    "button",
    {
      class: "btn-primary action-btn-item mirror-btn-prominent",
      style: "width: 100%; margin-bottom: 6px; padding: 6px 12px;",
      title: "Launch low-latency screen mirror using scrcpy",
    },
    icon(ICON_PHONE),
    text("Mirror Device Screen (scrcpy)")
  );
  mirrorBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:mirror", deviceId: device.id });
  });
  panel.appendChild(mirrorBtn);

  // 2. Main Actions Grid
  const actionsGrid = el("div", { class: "actions-buttons-grid" });

  // Screenshot (File)
  const shotBtn = el(
    "button",
    {
      class: "btn-secondary action-btn-item",
      disabled: isBusy("device:screenshot"),
      title: "Take Screenshot (saved to Pictures)",
    },
    icon(ICON_CAMERA),
    text("Screenshot")
  );
  shotBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:screenshot" });
  });

  // Copy Screenshot to OS Clipboard
  const clipShotBtn = el(
    "button",
    {
      class: "btn-secondary action-btn-item",
      disabled: isBusy(`screenshot:${device.id}`),
      title: "Capture screenshot and copy directly to OS clipboard",
    },
    icon(ICON_COPY),
    text("Copy Screen")
  );
  clipShotBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:screenshotClipboard", deviceId: device.id });
  });

  // Record / Stop
  const recBtn = el(
    "button",
    {
      class: `btn-secondary action-btn-item${isRec ? " is-recording" : ""}`,
      disabled: isBusy("device:record"),
      title: isRec ? "Stop Screen Recording" : "Record Device Screen",
    },
    icon(isRec ? ICON_STOP : ICON_RECORD),
    text(isRec ? `Stop ${recTime}` : "Record")
  );
  recBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:recordToggle" });
  });

  // Install APK
  const apkBtn = el(
    "button",
    {
      class: "btn-secondary action-btn-item",
      disabled: isBusy("device:installApk"),
      title: "Install APK onto this device",
    },
    icon(ICON_APK),
    text("Install APK")
  );
  apkBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:installApk" });
  });

  // Uninstall App
  const unBtn = el(
    "button",
    {
      class: "btn-secondary action-btn-item",
      disabled: isBusy("device:uninstall"),
      title: "Select and uninstall a 3rd-party application",
    },
    icon(ICON_TRASH),
    text("Uninstall")
  );
  unBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:uninstall" });
  });

  // Shell
  const shellBtn = el(
    "button",
    {
      class: "btn-secondary action-btn-item",
      title: "Open ADB Shell Terminal",
    },
    icon(ICON_TERMINAL),
    text("Shell")
  );
  shellBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:shell" });
  });

  append(actionsGrid, shotBtn, clipShotBtn, recBtn, apkBtn, unBtn, shellBtn);
  panel.appendChild(actionsGrid);

  // 3. Quick App Tools & Toggles Grid
  const appToolsHeader = el("div", { class: "section-label", style: "margin-top: 8px;" }, "Quick App Tools");
  panel.appendChild(appToolsHeader);

  const appToolsGrid = el("div", { class: "app-actions-grid" });

  const clearDataBtn = el(
    "button",
    {
      class: "btn-secondary btn-sm action-btn-item",
      disabled: isBusy(`clear:${device.id}`),
      title: "Clear user data & cache for an installed app",
    },
    icon(ICON_BROOM),
    text("Clear App Data")
  );
  clearDataBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:clearAppData", deviceId: device.id });
  });

  const appInfoBtn = el(
    "button",
    {
      class: "btn-secondary btn-sm action-btn-item",
      title: "Open App Details & Permissions in Android Settings",
    },
    icon(ICON_INFO),
    text("App Settings")
  );
  appInfoBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:openAppInfo", deviceId: device.id });
  });

  const wifiToggleBtn = el(
    "button",
    {
      class: "btn-secondary btn-sm action-btn-item",
      title: "Toggle Wi-Fi state on this device",
    },
    icon(ICON_WIFI),
    text("Toggle Wi-Fi")
  );
  wifiToggleBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "device:toggleWifi", deviceId: device.id });
  });

  append(appToolsGrid, clearDataBtn, appInfoBtn, wifiToggleBtn);
  panel.appendChild(appToolsGrid);

  // 4. Reverse Port Forwarding (Reverse Proxy)
  panel.appendChild(renderReversePortPanel(device));

  // 5. Deep Link Intent Dispatcher
  panel.appendChild(renderDeepLinkPanel(device));

  // 6. Collapsible Details Section
  const detailsHeader = el(
    "div",
    { class: "details-collapsible-header", role: "button", tabindex: "0" },
    text("Device Details"),
    icon(state.collapsed.details ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN)
  );

  detailsHeader.addEventListener("click", () => {
    state.collapsed.details = !state.collapsed.details;
    renderApp();
  });

  panel.appendChild(detailsHeader);

  if (!state.collapsed.details) {
    const table = el("div", { class: "device-details-table" });

    const rows: Array<[string, string]> = [
      ["Serial / ID", device.transport],
      ["IP Address", device.ipAddress || "N/A"],
      ["Model", device.model || "N/A"],
      ["Brand", device.brand || "N/A"],
      ["Android", `${device.androidVersion || "N/A"}${device.apiLevel ? ` (API ${device.apiLevel})` : ""}`],
      ["Battery", device.batteryLevel != null ? `${device.batteryLevel}%` : "N/A"],
      ["Connection", device.connectionType || "N/A"],
    ];

    for (const [k, v] of rows) {
      table.appendChild(el("div", { class: "detail-label" }, k));
      table.appendChild(el("div", { class: "detail-value" }, v));
    }

    const copyBtn = el(
      "button",
      { class: "btn-secondary btn-sm", style: "margin-top: 4px;" },
      icon(ICON_COPY),
      text("Copy Device Info")
    );
    copyBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "device:copyInfo" });
    });

    panel.appendChild(table);
    panel.appendChild(copyBtn);
  }

  return panel;
}

function renderReversePortPanel(device: Device): HTMLElement {
  const panel = el("div", { class: "reverse-panel", style: "margin-top: 8px;" });
  const titleRow = el(
    "div",
    { style: "display: flex; justify-content: space-between; align-items: center;" },
    el("span", { class: "section-label" }, "Port Forwarding (Reverse Proxy)"),
    el("span", { style: "font-size: 10px; color: var(--fdm-fg-dim);" }, "device → localhost")
  );

  const form = el("div", { class: "reverse-form" });
  const portInput = el("input", {
    type: "number",
    class: "reverse-input",
    placeholder: "Port (e.g. 8080)",
    value: state.reversePortInput,
  }) as HTMLInputElement;
  portInput.addEventListener("input", (e) => (state.reversePortInput = (e.target as HTMLInputElement).value));

  const addBtn = el("button", { class: "btn-secondary btn-sm" }, text("+ Reverse"));
  addBtn.addEventListener("click", () => {
    const port = Number(state.reversePortInput.trim());
    if (port > 0) {
      vscode.postMessage({ type: "reverse:add", deviceId: device.id, port });
      state.reversePortInput = "";
    }
  });

  append(form, portInput, addBtn);
  append(panel, titleRow, form);

  if (state.activeForwards && state.activeForwards.length > 0) {
    const list = el("div", { class: "reverse-list" });
    for (const f of state.activeForwards) {
      const item = el(
        "div",
        { class: "reverse-item" },
        el("span", { class: "reverse-badge" }, `tcp:${f.device} ⇄ tcp:${f.host}`),
        el("button", { class: "btn-ghost btn-sm danger-hover", title: "Remove port forward" }, text("✕"))
      );
      item.querySelector("button")?.addEventListener("click", () => {
        vscode.postMessage({ type: "reverse:remove", deviceId: device.id, port: f.host });
      });
      list.appendChild(item);
    }
    panel.appendChild(list);
  }
  return panel;
}

function renderDeepLinkPanel(device: Device): HTMLElement {
  const panel = el("div", { class: "deeplink-panel", style: "margin-top: 8px;" });
  const titleRow = el("div", { class: "section-label" }, "Deep Link / Intent Dispatcher");

  const form = el("div", { class: "deeplink-form" });
  const input = el("input", {
    type: "text",
    class: "deeplink-input",
    placeholder: "myapp://path or https://domain.com/app",
    value: state.deepLinkInput,
  }) as HTMLInputElement;
  input.addEventListener("input", (e) => (state.deepLinkInput = (e.target as HTMLInputElement).value));

  const sendBtn = el("button", { class: "btn-secondary btn-sm" }, text("🚀 Open"));
  sendBtn.addEventListener("click", () => {
    const val = state.deepLinkInput.trim();
    if (val) {
      vscode.postMessage({ type: "device:openDeepLink", deviceId: device.id, url: val });
    }
  });

  append(form, input, sendBtn);
  append(panel, titleRow, form);
  return panel;
}

function renderDeviceHistorySection(): HTMLElement | null {
  if (state.history.length === 0) return null;

  const section = el("div", { class: "collapsible-section" });
  const isCollapsed = state.collapsed.history;

  const header = el(
    "div",
    { class: "section-toggle-header", role: "button", tabindex: "0" },
    el(
      "div",
      { style: "display: flex; align-items: center; gap: 6px;" },
      text("Device History"),
      el("span", { class: "count-pill" }, `${state.history.length}`)
    ),
    el(
      "div",
      { style: "display: flex; align-items: center; gap: 6px;" },
      icon(isCollapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN)
    )
  );

  header.addEventListener("click", () => {
    state.collapsed.history = !state.collapsed.history;
    renderApp();
  });
  section.appendChild(header);

  if (!isCollapsed) {
    const content = el("div", { class: "section-content" });

    const actionsRow = el(
      "div",
      { style: "display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;" },
      el("span", { class: "section-label" }, "Previously Connected"),
      el(
        "button",
        {
          class: "btn-secondary btn-sm",
          disabled: isBusy("history:autoConnect"),
          title: "Attempt connecting to all saved wireless devices",
        },
        icon(ICON_LIGHTNING),
        text("Auto-Connect All")
      )
    );
    actionsRow.querySelector("button")?.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "history:autoConnectAll" });
    });
    content.appendChild(actionsRow);

    const list = el("div", { class: "history-list" });
    for (const item of state.history) {
      const isAlreadyConnected = state.devices.some(
        (d) => d.id === item.id && d.state === "connected"
      );
      const timeAgo = formatTimeAgo(item.lastConnected);

      const row = el(
        "div",
        { class: "history-row" },
        el(
          "div",
          { class: "history-info" },
          icon(item.connectionType === "wireless" ? ICON_WIFI : ICON_USB),
          el(
            "div",
            { class: "history-text" },
            el("div", { class: "history-name" }, item.name || item.transport),
            el("div", { class: "history-meta" }, `${item.transport} · ${timeAgo}`)
          )
        )
      );

      const actions = el("div", { class: "history-actions" });

      if (isAlreadyConnected) {
        actions.appendChild(
          el("span", { class: "badge badge-wireless" }, icon(ICON_CHECK), text("Connected"))
        );
      } else {
        const connectBtn = el(
          "button",
          {
            class: "btn-secondary btn-sm",
            disabled: isBusy(`connect:${item.id}`),
            title: "Quick Connect",
          },
          text("Connect")
        );
        connectBtn.addEventListener("click", () => {
          vscode.postMessage({ type: "history:connect", id: item.id });
        });
        actions.appendChild(connectBtn);
      }

      const removeBtn = el(
        "button",
        {
          class: "btn-ghost btn-icon-only danger-hover",
          title: "Remove from history",
        },
        icon(ICON_CLOSE)
      );
      removeBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "history:remove", id: item.id });
      });
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      list.appendChild(row);
    }

    content.appendChild(list);
    section.appendChild(content);
  }

  return section;
}

function renderProjectToolsSection(): HTMLElement {
  const section = el("div", { class: "collapsible-section" });

  const header = el(
    "div",
    { class: "section-toggle-header", role: "button", tabindex: "0" },
    text("Project Tools"),
    icon(state.collapsed.project ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN)
  );

  header.addEventListener("click", () => {
    state.collapsed.project = !state.collapsed.project;
    vscode.postMessage({
      type: "ui:toggleProjectTools",
      collapsed: state.collapsed.project,
    });
    renderApp();
  });

  section.appendChild(header);

  if (!state.collapsed.project) {
    const content = el("div", { class: "section-content" });
    const row = el("div", { class: "button-row-wrap" });

    const cleanBtn = el(
      "button",
      {
        class: "btn-secondary btn-sm",
        disabled: isBusy("flutter:clean"),
        title: "Run flutter clean (switches to Logs)",
      },
      icon(ICON_BROOM),
      text("Clean")
    );
    cleanBtn.addEventListener("click", () => {
      state.tab = "logs";
      renderApp();
      vscode.postMessage({ type: "flutter:clean" });
    });

    const pubGetBtn = el(
      "button",
      {
        class: "btn-secondary btn-sm",
        disabled: isBusy("flutter:pubGet"),
        title: "Run flutter pub get (switches to Logs)",
      },
      icon(ICON_DOWNLOAD),
      text("Pub Get")
    );
    pubGetBtn.addEventListener("click", () => {
      state.tab = "logs";
      renderApp();
      vscode.postMessage({ type: "flutter:pubGet" });
    });

    const doctorBtn = el(
      "button",
      {
        class: "btn-secondary btn-sm",
        disabled: isBusy("flutter:doctor"),
        title: "Run flutter doctor (switches to Logs)",
      },
      icon(ICON_SHIELD),
      text("Doctor")
    );
    doctorBtn.addEventListener("click", () => {
      state.tab = "logs";
      renderApp();
      vscode.postMessage({ type: "flutter:doctor" });
    });

    const moreBtn = el(
      "button",
      { class: "btn-secondary btn-sm", title: "More Project Commands" },
      icon(ICON_MORE),
      text("More")
    );
    moreBtn.addEventListener("click", () => {
      state.moreProjectMenuOpen = !state.moreProjectMenuOpen;
      renderApp();
    });

    append(row, cleanBtn, pubGetBtn, doctorBtn, moreBtn);
    content.appendChild(row);

    if (state.moreProjectMenuOpen) {
      const moreRow = el("div", { class: "button-row-wrap", style: "padding-top: 4px;" });

      const pubUpBtn = el(
        "button",
        { class: "btn-ghost btn-sm", disabled: isBusy("flutter:pubUpgrade") },
        text("Pub Upgrade")
      );
      pubUpBtn.addEventListener("click", () => {
        state.tab = "logs";
        renderApp();
        vscode.postMessage({ type: "flutter:pubUpgrade" });
      });

      const analyzeBtn = el(
        "button",
        { class: "btn-ghost btn-sm", disabled: isBusy("flutter:analyze") },
        text("Analyze")
      );
      analyzeBtn.addEventListener("click", () => {
        state.tab = "logs";
        renderApp();
        vscode.postMessage({ type: "flutter:analyze" });
      });

      const formatBtn = el(
        "button",
        { class: "btn-ghost btn-sm", disabled: isBusy("flutter:format") },
        text("Format (dart format .)")
      );
      formatBtn.addEventListener("click", () => {
        state.tab = "logs";
        renderApp();
        vscode.postMessage({ type: "flutter:format" });
      });

      append(moreRow, pubUpBtn, analyzeBtn, formatBtn);
      content.appendChild(moreRow);
    }

    section.appendChild(content);
  }

  return section;
}

// ---------------------------------------------------------------------------
// Wireless Tab (Stepper Layout)
// ---------------------------------------------------------------------------

function renderWirelessTab(parent: HTMLElement): void {
  const stepper = el("div", { class: "wireless-stepper" });

  // Step 1: QR Code Pairing
  stepper.appendChild(renderStepQr());

  // Step 2: Pair with 6-digit Code
  stepper.appendChild(renderStepCode());

  // Step 3: Direct Connect
  stepper.appendChild(renderStepDirect());

  // Recent Wireless Devices List
  const recentCards = renderRecentDevicesList();
  if (recentCards) stepper.appendChild(recentCards);

  // Advanced TCP/IP & mDNS Collapsible
  stepper.appendChild(renderAdvancedWirelessSection());

  parent.appendChild(stepper);
}

function renderStepQr(): HTMLElement {
  const card = el("div", { class: "step-card" });

  const header = el(
    "div",
    { class: "step-header" },
    el("div", { class: "step-num" }, "1"),
    el("div", { class: "step-title" }, "Pair with QR Code (Recommended)")
  );
  card.appendChild(header);

  if (!state.qr) {
    const desc = el(
      "div",
      { class: "empty-state-description" },
      "Open Developer options → Wireless debugging → 'Pair device with QR code' on your phone, then click below to scan."
    );

    const startBtn = el(
      "button",
      {
        class: "btn-primary btn-sm",
        disabled: isBusy("wireless:qr"),
      },
      icon(ICON_QR),
      text("Generate Pairing QR")
    );
    startBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "wireless:qrStart" });
    });

    append(card, desc, startBtn);
  } else {
    const qrBox = el("div", { class: "qr-box-container" });

    const qrWrapper = el("div", { class: "qr-image-wrapper" });
    if (qrDataUrl) {
      const img = el("img", { src: qrDataUrl, alt: "Pairing QR Code" });
      qrWrapper.appendChild(img);
    } else {
      qrWrapper.appendChild(text("Generating QR code..."));
    }

    const remaining = Math.max(0, Math.ceil((state.qr.expiresAt - Date.now()) / 1000));
    const countdownBadge = el(
      "div",
      { id: "qr-countdown-status", class: "countdown-badge" },
      `Waiting for phone to scan QR (${remaining}s remaining)...`
    );

    const cancelBtn = el(
      "button",
      { class: "btn-secondary btn-sm" },
      icon(ICON_CLOSE),
      text("Cancel QR Pairing")
    );
    cancelBtn.addEventListener("click", () => {
      stopQrCountdown();
      vscode.postMessage({ type: "wireless:qrCancel" });
      state.qr = null;
      renderApp();
    });

    append(qrBox, qrWrapper, countdownBadge, cancelBtn);
    card.appendChild(qrBox);
  }

  return card;
}

function renderStepCode(): HTMLElement {
  const card = el("div", { class: "step-card" });

  const header = el(
    "div",
    { class: "step-header" },
    el("div", { class: "step-num" }, "2"),
    el("div", { class: "step-title" }, "Pair with 6-digit Code")
  );

  const desc = el(
    "div",
    { class: "empty-state-description" },
    "Tap 'Pair device with pairing code' on your phone and enter the IP, pairing port, and 6-digit code:"
  );

  const ipInput = el("input", {
    type: "text",
    class: "text-input",
    placeholder: "IP (e.g. 192.168.1.4)",
    value: forms.pairIp,
  }) as HTMLInputElement;
  ipInput.addEventListener("input", (e) => (forms.pairIp = (e.target as HTMLInputElement).value));

  const portInput = el("input", {
    type: "text",
    class: "text-input",
    placeholder: "Pair Port",
    value: forms.pairPort,
  }) as HTMLInputElement;
  portInput.addEventListener("input", (e) => (forms.pairPort = (e.target as HTMLInputElement).value));

  const codeInput = el("input", {
    type: "text",
    class: "text-input",
    placeholder: "6-digit code",
    maxlength: "6",
    value: forms.pairCode,
  }) as HTMLInputElement;
  codeInput.addEventListener("input", (e) => (forms.pairCode = (e.target as HTMLInputElement).value));

  const connectPortInput = el("input", {
    type: "text",
    class: "text-input",
    placeholder: "Connect Port (Optional)",
    value: forms.pairConnectPort,
  }) as HTMLInputElement;
  connectPortInput.addEventListener(
    "input",
    (e) => (forms.pairConnectPort = (e.target as HTMLInputElement).value)
  );

  const pairBtn = el(
    "button",
    {
      class: "btn-secondary btn-sm",
      disabled: isBusy("wireless:pair"),
    },
    icon(ICON_KEY),
    text("Pair & Connect")
  );

  pairBtn.addEventListener("click", () => {
    const host = forms.pairIp.trim();
    const port = Number(forms.pairPort.trim());
    const code = forms.pairCode.trim();
    const connectPort = forms.pairConnectPort.trim() ? Number(forms.pairConnectPort.trim()) : undefined;

    if (!host || !port || !code) return;
    vscode.postMessage({
      type: "wireless:pair",
      host,
      port,
      code,
      connectPort,
    });
  });

  const row1 = el("div", { class: "form-grid-2col" }, ipInput, portInput);
  const row2 = el("div", { class: "form-grid-2col" }, codeInput, connectPortInput);

  append(card, header, desc, row1, row2, pairBtn);
  return card;
}

function renderStepDirect(): HTMLElement {
  const card = el("div", { class: "step-card" });

  const header = el(
    "div",
    { class: "step-header" },
    el("div", { class: "step-num" }, "3"),
    el("div", { class: "step-title" }, "Direct Connect (Already Paired)")
  );

  const desc = el(
    "div",
    { class: "empty-state-description" },
    "Enter the IP and Connect Port from the Wireless debugging screen:"
  );

  const input = el("input", {
    type: "text",
    class: "text-input",
    placeholder: "192.168.1.4:41857",
    value: forms.directAddress,
  }) as HTMLInputElement;
  input.addEventListener("input", (e) => (forms.directAddress = (e.target as HTMLInputElement).value));

  const connectBtn = el(
    "button",
    {
      class: "btn-secondary btn-sm",
      disabled: isBusy("wireless:connect"),
    },
    icon(ICON_LINK),
    text("Connect")
  );
  connectBtn.addEventListener("click", () => {
    const val = forms.directAddress.trim();
    if (val) vscode.postMessage({ type: "wireless:connect", transport: val });
  });

  const row = el("div", { class: "form-grid-2col" }, input, connectBtn);
  append(card, header, desc, row);
  return card;
}

function renderRecentDevicesList(): HTMLElement | null {
  const recent = state.devices.filter((d) => d.isRemembered && d.state !== "connected");
  if (recent.length === 0) return null;

  const card = el("div", { class: "step-card" });
  card.appendChild(el("div", { class: "section-label" }, "Recent Wireless Devices"));

  const list = el("div", { class: "recent-list" });
  for (const d of recent) {
    const row = el("div", { class: "recent-row" });

    const info = el(
      "div",
      { class: "recent-info" },
      el("span", { class: "status-dot status-disconnected" }),
      el(
        "div",
        { class: "recent-text" },
        el("div", { class: "device-name" }, d.name || d.ipAddress || d.transport),
        el("div", { class: "recent-endpoint" }, d.transport)
      )
    );

    const connectBtn = el(
      "button",
      {
        class: "btn-secondary btn-sm",
        disabled: isBusy(`connect:${d.id}`),
        title: "Reconnect",
      },
      text("Connect")
    );
    connectBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "device:connect", deviceId: d.id });
    });

    const forgetBtn = el(
      "button",
      {
        class: "btn-ghost btn-sm danger-hover",
        title: "Forget remembered device",
      },
      text("Forget")
    );
    forgetBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "wireless:forget", transport: d.transport });
    });

    const actions = el("div", { class: "recent-actions" }, connectBtn, forgetBtn);
    append(row, info, actions);
    list.appendChild(row);
  }

  card.appendChild(list);
  return card;
}

function renderAdvancedWirelessSection(): HTMLElement {
  const section = el("div", { class: "collapsible-section" });

  const header = el(
    "div",
    { class: "section-toggle-header", role: "button", tabindex: "0" },
    text("Advanced Wireless & TCP/IP"),
    icon(state.collapsed.advancedWireless ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN)
  );
  header.addEventListener("click", () => {
    state.collapsed.advancedWireless = !state.collapsed.advancedWireless;
    renderApp();
  });
  section.appendChild(header);

  if (!state.collapsed.advancedWireless) {
    const content = el("div", { class: "section-content" });

    content.appendChild(el("div", { class: "section-label" }, "Classic TCP/IP over USB"));
    const tcpDesc = el(
      "div",
      { class: "empty-state-description" },
      "Run 'adb tcpip 5555' on a connected USB phone to enable wireless debugging on Android 10 and below."
    );

    const tcpInput = el("input", {
      type: "text",
      class: "text-input",
      style: "width: 80px;",
      value: forms.tcpipPort,
    }) as HTMLInputElement;
    tcpInput.addEventListener("input", (e) => (forms.tcpipPort = (e.target as HTMLInputElement).value));

    const tcpBtn = el(
      "button",
      { class: "btn-secondary btn-sm", disabled: isBusy("wireless:tcpip") },
      text("Enable TCP/IP")
    );
    tcpBtn.addEventListener("click", () => {
      const port = Number(forms.tcpipPort.trim()) || 5555;
      vscode.postMessage({ type: "wireless:tcpip", port });
    });

    const tcpRow = el("div", { class: "button-row-wrap" }, tcpInput, tcpBtn);
    append(content, tcpDesc, tcpRow);

    if (state.mdnsStatus) {
      content.appendChild(el("div", { class: "section-label", style: "margin-top: 8px;" }, "mDNS Status"));
      const mdnsMsg = el(
        "div",
        { class: "empty-state-description" },
        `${state.mdnsStatus.message} (${state.mdns.length} service(s) found)`
      );
      content.appendChild(mdnsMsg);
    }

    section.appendChild(content);
  }

  return section;
}

// ---------------------------------------------------------------------------
// Logs Tab
// ---------------------------------------------------------------------------

let logsContainerEl: HTMLElement | null = null;

function renderLogsTab(parent: HTMLElement): void {
  const toolbar = el("div", { class: "logs-toolbar" });

  const searchInput = el("input", {
    type: "text",
    class: "text-input log-search-input",
    placeholder: "Filter logs...",
    value: state.logSearch,
  }) as HTMLInputElement;
  searchInput.addEventListener("input", (e) => {
    state.logSearch = (e.target as HTMLInputElement).value.toLowerCase();
    updateLogsView();
  });

  const filterSelect = el("select", { class: "device-select log-filter-select" });
  const levels: Array<LogLevel | "all"> = ["all", "info", "warn", "error"];
  for (const l of levels) {
    const opt = el("option", { value: l, selected: state.logFilter === l }, l);
    filterSelect.appendChild(opt);
  }
  filterSelect.addEventListener("change", (e) => {
    state.logFilter = (e.target as HTMLSelectElement).value as LogLevel | "all";
    vscode.postMessage({ type: "logs:filter", level: state.logFilter });
    updateLogsView();
  });

  // Auto-scroll Toggle Button
  const autoScrollBtn = el(
    "button",
    {
      class: `btn-secondary btn-sm${state.autoScrollLogs ? " active" : ""}`,
      title: state.autoScrollLogs ? "Auto-scroll to bottom ON (click to pause)" : "Auto-scroll OFF (click to lock to bottom)",
      style: "font-size: 11px; padding: 3px 8px; gap: 4px;",
    },
    icon(ICON_CHEVRON_DOWN),
    text(state.autoScrollLogs ? "Auto-Scroll: ON" : "Auto-Scroll: OFF")
  );
  autoScrollBtn.addEventListener("click", () => {
    state.autoScrollLogs = !state.autoScrollLogs;
    renderApp();
    if (state.autoScrollLogs && logsContainerEl) {
      logsContainerEl.scrollTop = logsContainerEl.scrollHeight;
    }
  });

  const pauseBtn = el(
    "button",
    {
      class: "btn-secondary btn-icon-only",
      title: state.logPaused ? "Resume Log Stream" : "Pause Log Stream",
    },
    icon(state.logPaused ? ICON_PLAY : ICON_STOP)
  );
  pauseBtn.addEventListener("click", () => {
    state.logPaused = !state.logPaused;
    vscode.postMessage({ type: state.logPaused ? "logs:pause" : "logs:resume" });
    renderApp();
  });

  const clearBtn = el(
    "button",
    { class: "btn-ghost btn-icon-only", title: "Clear Logs" },
    icon(ICON_BROOM)
  );
  clearBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "logs:clear" });
  });

  const moreBtn = el(
    "button",
    { class: "btn-ghost btn-icon-only", title: "Copy or Export Logs" },
    icon(ICON_MORE)
  );
  moreBtn.addEventListener("click", () => {
    state.moreLogsMenuOpen = !state.moreLogsMenuOpen;
    renderApp();
  });

  append(toolbar, searchInput, filterSelect, autoScrollBtn, pauseBtn, clearBtn, moreBtn);
  parent.appendChild(toolbar);

  // Quick Preset Filters Bar
  const presetsRow = el("div", { class: "log-presets-bar" });
  const presets: Array<{ id: LogPresetFilter; label: string }> = [
    { id: "all", label: "All Logs" },
    { id: "flutter", label: "Flutter Only" },
    { id: "crashes", label: "Fatal Crashes" },
    { id: "network", label: "Network / HTTP" },
  ];
  for (const p of presets) {
    const isPresetActive = (state.logPreset || "all") === p.id;
    const chip = el(
      "button",
      { class: `log-preset-btn${isPresetActive ? " active" : ""}` },
      text(p.label)
    );
    chip.addEventListener("click", () => {
      state.logPreset = p.id;
      vscode.postMessage({ type: "logs:setPreset", preset: p.id });
      renderApp();
    });
    presetsRow.appendChild(chip);
  }
  parent.appendChild(presetsRow);

  if (state.moreLogsMenuOpen) {
    const moreRow = el("div", { class: "button-row-wrap", style: "padding-bottom: 4px;" });
    const copyBtn = el("button", { class: "btn-secondary btn-sm" }, icon(ICON_COPY), text("Copy All"));
    copyBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "logs:copy" });
    });
    const exportBtn = el("button", { class: "btn-secondary btn-sm" }, icon(ICON_DOWNLOAD), text("Export .txt"));
    exportBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "logs:export" });
    });
    append(moreRow, copyBtn, exportBtn);
    parent.appendChild(moreRow);
  }

  logsContainerEl = el("div", { class: "logs-container" });
  logsContainerEl.addEventListener("scroll", () => {
    if (!logsContainerEl) return;
    const isAtBottom =
      logsContainerEl.scrollHeight - logsContainerEl.scrollTop - logsContainerEl.clientHeight < 30;
    if (!isAtBottom && state.autoScrollLogs) {
      state.autoScrollLogs = false;
      autoScrollBtn.textContent = "";
      append(autoScrollBtn, icon(ICON_CHEVRON_DOWN), text("Auto-Scroll: OFF"));
      autoScrollBtn.classList.remove("active");
    } else if (isAtBottom && !state.autoScrollLogs) {
      state.autoScrollLogs = true;
      autoScrollBtn.textContent = "";
      append(autoScrollBtn, icon(ICON_CHEVRON_DOWN), text("Auto-Scroll: ON"));
      autoScrollBtn.classList.add("active");
    }
  });

  parent.appendChild(logsContainerEl);
  updateLogsView();
}

function updateLogsView(): void {
  if (!logsContainerEl) return;
  clear(logsContainerEl);

  const filtered = state.logs.filter((entry) => {
    if (state.logFilter !== "all" && entry.level !== state.logFilter) return false;
    if (state.logSearch && !entry.message.toLowerCase().includes(state.logSearch)) {
      return false;
    }
    if (state.logPreset === "flutter") {
      const isFlutter =
        (entry.tag && entry.tag.toLowerCase().includes("flutter")) ||
        entry.message.toLowerCase().includes("flutter");
      if (!isFlutter) return false;
    } else if (state.logPreset === "crashes") {
      const isCrash =
        entry.level === "error" ||
        /fatal|exception|crash|unhandled|androidruntime/i.test(entry.message) ||
        (entry.tag ? /androidruntime/i.test(entry.tag) : false);
      if (!isCrash) return false;
    } else if (state.logPreset === "network") {
      const isNet = /https?:\/\/|dio|okhttp|retrofit|socket|websocket|http/i.test(entry.message);
      if (!isNet) return false;
    }
    return true;
  });

  for (const entry of filtered) {
    const row = el(
      "div",
      { class: `log-row level-${entry.level}` },
      el("span", { class: "log-time" }, fmtTime(entry.timestamp)),
      el("span", { class: `log-badge badge-${entry.level}` }, entry.level),
      el("span", { class: "log-msg" }, entry.message)
    );

    if (entry.count && entry.count > 1) {
      row.appendChild(el("span", { class: "log-multiplier" }, `×${entry.count}`));
    }

    logsContainerEl.appendChild(row);
  }

  if (state.autoScrollLogs) {
    logsContainerEl.scrollTop = logsContainerEl.scrollHeight;
  }
}

function renderSupportFooter(): HTMLElement {
  const footer = el("footer", { class: "support-footer" });
  const textRow = el("span", { class: "support-footer-title" }, "Support Flutter Device Manager");

  const kofiBtn = el(
    "a",
    {
      class: "kofi-pill-btn",
      href: "https://ko-fi.com/skrelectronicslab",
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Support Flutter Device Manager on Ko-fi",
    },
    icon(ICON_KOFI),
    el("span", { class: "kofi-text" }, "Support on Ko-fi")
  );
  kofiBtn.addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({
      type: "ui:action",
      command: "fdm.openExternal",
      payload: { url: "https://ko-fi.com/skrelectronicslab" },
    });
  });

  const creatorRow = el("div", { class: "creator-row" });
  const creatorLabel = el("span", { class: "creator-label" }, "Made with ");
  const heart = icon(ICON_HEART);
  const byLabel = el("span", { class: "creator-label" }, " by ");
  const creatorLink = el(
    "a",
    {
      class: "creator-link",
      href: "https://skrelectronicslab.com",
      title: "Visit SKR Electronics Lab (skrelectronicslab.com)",
    },
    text("SKR Electronics Lab"),
    icon(ICON_EXTERNAL)
  );
  creatorLink.addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({
      type: "ui:action",
      command: "fdm.openExternal",
      payload: { url: "https://skrelectronicslab.com" },
    });
  });
  append(creatorRow, creatorLabel, heart, byLabel, creatorLink);

  append(footer, textRow, kofiBtn, creatorRow);
  return footer;
}

// ---------------------------------------------------------------------------
// Toast Notification Stack
// ---------------------------------------------------------------------------

function renderToasts(): HTMLElement {
  const stack = el("div", { class: "toast-stack" });

  for (const n of state.notifications) {
    const iconSvg =
      n.level === "success"
        ? ICON_CHECK
        : n.level === "warn"
        ? ICON_WARNING
        : n.level === "error"
        ? ICON_ERROR
        : ICON_INFO;

    const toast = el(
      "div",
      { class: `toast-item toast-${n.level}` },
      el(
        "div",
        { class: "toast-body" },
        icon(iconSvg),
        el("span", { class: "toast-message" }, n.message)
      )
    );

    const actionsContainer = el("div", { class: "toast-actions" });

    if (n.actions && n.actions.length > 0) {
      for (const act of n.actions) {
        const btn = el("button", { class: "btn-secondary btn-sm" }, text(act.label));
        btn.addEventListener("click", () => {
          vscode.postMessage({
            type: "ui:action",
            command: act.command,
            payload: act.payload,
          });
        });
        actionsContainer.appendChild(btn);
      }
    }

    const closeBtn = el(
      "button",
      { class: "btn-ghost btn-icon-only", title: "Dismiss" },
      icon(ICON_CLOSE)
    );
    closeBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "ui:dismissNotification", id: n.id });
      state.notifications = state.notifications.filter((x) => x.id !== n.id);
      renderApp();
    });

    actionsContainer.appendChild(closeBtn);
    toast.appendChild(actionsContainer);
    stack.appendChild(toast);
  }

  return stack;
}

// ---------------------------------------------------------------------------
// Message Event Dispatcher
// ---------------------------------------------------------------------------

window.addEventListener("message", async (event: MessageEvent<ServerMessage>) => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case "ui:state": {
      state.tab = msg.state.tab;
      state.devices = msg.state.devices;
      state.history = msg.state.history || [];
      state.mdns = msg.state.mdns;
      state.mdnsStatus = msg.state.mdnsStatus;
      state.selectedDeviceId = msg.state.selectedDeviceId;
      state.flutter = msg.state.flutter;
      state.logs = msg.state.logs;
      state.logFilter = msg.state.logFilter;
      if (msg.state.logPreset) state.logPreset = msg.state.logPreset;
      if (msg.state.activeForwards) state.activeForwards = msg.state.activeForwards;
      state.logPaused = msg.state.logPaused;
      state.busy = msg.state.busy;
      state.notifications = msg.state.notifications;
      state.recording = msg.state.recording;
      state.ready = msg.state.ready;
      if (msg.state.projectToolsCollapsed !== undefined) {
        state.collapsed.project = msg.state.projectToolsCollapsed;
      }
      renderApp();
      break;
    }

    case "reverse:updated": {
      state.activeForwards = msg.forwards;
      renderApp();
      break;
    }

    case "busy": {
      if (msg.active) {
        state.busy[msg.key] = msg.label || msg.key;
      } else {
        delete state.busy[msg.key];
      }
      renderApp();
      break;
    }

    case "ui:notify": {
      if (!state.notifications.some((n) => n.id === msg.notification.id)) {
        state.notifications.push(msg.notification);
        if (msg.notification.level === "success" || msg.notification.level === "info") {
          setTimeout(() => {
            state.notifications = state.notifications.filter((n) => n.id !== msg.notification.id);
            vscode.postMessage({ type: "ui:dismissNotification", id: msg.notification.id });
            renderApp();
          }, 5000);
        }
        renderApp();
      }
      break;
    }

    case "logs:appended": {
      for (const entry of msg.entries) {
        const existingIdx = state.logs.findIndex((l) => l.id === entry.id);
        if (existingIdx >= 0) {
          state.logs[existingIdx] = entry;
        } else {
          state.logs.push(entry);
          if (state.logs.length > 500) {
            state.logs.shift();
          }
        }
      }
      if (state.tab === "logs") {
        updateLogsView();
      }
      break;
    }

    case "logs:cleared": {
      state.logs = [];
      if (state.tab === "logs") {
        updateLogsView();
      }
      break;
    }

    case "flutter:progress": {
      state.flutter = { status: msg.status, message: msg.message };
      renderApp();
      break;
    }

    case "recording:tick": {
      state.recording = msg.recording;
      if (state.tab === "devices") {
        renderApp();
      }
      break;
    }

    case "wireless:qr": {
      state.qr = {
        payload: msg.payload,
        expiresAt: msg.expiresAt,
        phase: "waiting",
        message: "Scan with your phone camera",
      };
      qrDataUrl = await generateQrDataUrl(msg.payload);
      startQrCountdown();
      renderApp();
      break;
    }

    case "wireless:qrStatus": {
      if (state.qr) {
        state.qr.phase = msg.phase;
        state.qr.message = msg.message;
        renderApp();
      }
      break;
    }

    case "wireless:qrDone": {
      stopQrCountdown();
      state.qr = null;
      qrDataUrl = "";
      renderApp();
      break;
    }
  }
});

// Boot the webview
initApp();