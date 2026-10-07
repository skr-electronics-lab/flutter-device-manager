import { Device } from "../../models/types";
import { el, append, icon, text } from "../dom";
import {
  ICON_PHONE,
  ICON_EMULATOR,
  ICON_WIFI,
  ICON_USB,
} from "../icons";

export interface DeviceCardActions {
  onSelect: (id: string) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onMirror?: (id: string) => void;
  busyKey: (key: string) => boolean;
}

function stateLabel(d: Device): string {
  switch (d.state) {
    case "connected":
      return "Connected";
    case "unauthorized":
      return "Unauthorized";
    case "offline":
      return "Offline";
    case "disconnected":
    case "pairing":
      return "Not connected";
    default:
      return "Unknown";
  }
}

function batteryMarkup(level: number | null): HTMLElement | null {
  if (level === null || level === undefined) return null;
  const fill = Math.max(5, Math.min(100, level));
  const colorClass =
    level <= 15 ? "battery-low" : level <= 30 ? "battery-medium" : "battery-good";

  const span = el(
    "span",
    { class: `battery-indicator ${colorClass}`, title: `Battery: ${level}%` },
    el(
      "span",
      { class: "battery-shell" },
      el("span", { class: "battery-fill", style: `width: ${fill}%;` })
    ),
    el("span", { class: "battery-pct" }, `${level}%`)
  );
  return span;
}

function connectionBadge(device: Device): HTMLElement {
  const isWireless =
    device.connectionType === "wireless" ||
    device.transport.includes("._adb-tls-connect.") ||
    /:\d+$/.test(device.transport);

  if (isWireless) {
    return el(
      "span",
      { class: "badge badge-wireless", title: "Wireless Debugging" },
      icon(ICON_WIFI),
      text("Wi-Fi")
    );
  }
  if (device.connectionType === "emulator" || device.isEmulator) {
    return el(
      "span",
      { class: "badge badge-emulator", title: "Android Emulator" },
      icon(ICON_EMULATOR),
      text("Emulator")
    );
  }
  return el(
    "span",
    { class: "badge badge-usb", title: "USB Connected" },
    icon(ICON_USB),
    text("USB")
  );
}

export function renderDeviceCard(
  device: Device,
  selected: boolean,
  actions: DeviceCardActions
): HTMLElement {
  const connected = device.state === "connected";
  const isWireless =
    device.connectionType === "wireless" ||
    device.transport.includes("._adb-tls-connect.") ||
    /:\d+$/.test(device.transport);

  const card = el("div", {
    class:
      `device-card` +
      (selected ? " selected" : "") +
      (device.state === "offline" ? " state-offline" : "") +
      (device.state === "unauthorized" ? " state-unauthorized" : ""),
    tabindex: "0",
    role: "button",
    "aria-label": `${device.name || device.transport} - ${stateLabel(device)}`,
  });

  card.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    actions.onSelect(device.id);
  });

  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      actions.onSelect(device.id);
    }
  });

  const avatar = el(
    "div",
    { class: `device-avatar ${device.isEmulator ? "avatar-emulator" : "avatar-phone"}` },
    icon(device.isEmulator ? ICON_EMULATOR : ICON_PHONE)
  );

  const titleRow = el(
    "div",
    { class: "device-identity" },
    el("div", { class: "device-name", title: device.name || device.transport }, device.name || device.transport),
    el(
      "div",
      { class: "device-subtext" },
      [device.model && device.model !== device.name ? device.model : null, device.ipAddress ? device.ipAddress : null]
        .filter(Boolean)
        .join(" · ") || device.transport
    )
  );

  const headerRight = el("div", { class: "device-header-right" });

  if (device.state === "disconnected" || device.state === "pairing") {
    const isConnecting = actions.busyKey(`connect:${device.id}`);
    const btn = el(
      "button",
      {
        class: "btn-secondary btn-sm inline-action-btn",
        disabled: isConnecting,
        title: "Connect wireless device",
      },
      isConnecting ? text("Connecting...") : text("Connect")
    );
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      actions.onConnect(device.id);
    });
    headerRight.appendChild(btn);
  } else if (device.state === "offline") {
    const isDisconnecting = actions.busyKey(`disconnect:${device.id}`);
    const btn = el(
      "button",
      {
        class: "btn-ghost btn-sm inline-action-btn danger-hover",
        disabled: isDisconnecting,
        title: "Remove offline device socket from ADB",
      },
      text("✕ Remove")
    );
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      actions.onDisconnect(device.id);
    });
    headerRight.appendChild(btn);
  } else if (connected) {
    if (actions.onMirror) {
      const mirrorBtn = el(
        "button",
        {
          class: "btn-ghost btn-sm inline-action-btn",
          title: "Mirror screen using scrcpy",
        },
        text("Mirror")
      );
      mirrorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        actions.onMirror?.(device.id);
      });
      headerRight.appendChild(mirrorBtn);
    }

    if (isWireless) {
      const isDisconnecting = actions.busyKey(`disconnect:${device.id}`);
      const btn = el(
        "button",
        {
          class: "btn-ghost btn-sm inline-action-btn danger-hover",
          disabled: isDisconnecting,
          title: "Disconnect wireless session",
        },
        isDisconnecting ? text("Disconnecting...") : text("Disconnect")
      );
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        actions.onDisconnect(device.id);
      });
      headerRight.appendChild(btn);
    }
  }

  const top = el("div", { class: "device-top" }, avatar, titleRow, headerRight);

  const metaItems = [
    el("span", { class: `status-dot status-${device.state}`, title: stateLabel(device) }),
    el("span", { class: "state-label" }, stateLabel(device)),
    connectionBadge(device),
  ];

  if (device.androidVersion) {
    metaItems.push(el("span", { class: "version-pill" }, `Android ${device.androidVersion}`));
  }

  const batt = batteryMarkup(device.batteryLevel);
  if (batt) metaItems.push(batt);

  const meta = el("div", { class: "device-meta" }, ...metaItems);

  append(card, top, meta);

  if (device.state === "unauthorized") {
    const hint = el(
      "div",
      { class: "device-card-banner banner-warning" },
      text("Device unauthorized. Unlock phone and tap 'Allow USB debugging'.")
    );
    card.appendChild(hint);
  }

  return card;
}