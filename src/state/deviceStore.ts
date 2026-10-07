import { EventEmitter } from "vscode";
import {
  AdbState,
  ConnectionType,
  Device,
  DeviceState,
  MdnsService,
  MdnsStatus,
} from "../models/types";
import { AdbService, connectionTypeOf, parseIpPort } from "../services/adb";
import { logger } from "../utils/logger";

function stateFromAdb(state: AdbState): DeviceState {
  switch (state) {
    case "authorized":
      return "connected";
    case "unauthorized":
      return "unauthorized";
    case "offline":
      return "offline";
    default:
      return "unknown";
  }
}

/**
 * Manages active and remembered device state.
 * Preserves probed metadata and excludes connected devices from recent lists.
 */
export class DeviceStore {
  private devices: Device[] = [];
  private mdnsList: MdnsService[] = [];
  private mdnsStatusState: MdnsStatus = { available: false, message: "" };
  private selectedId?: string;

  readonly onDevicesChanged = new EventEmitter<Device[]>();
  readonly onMdnsChanged = new EventEmitter<MdnsService[]>();
  readonly onSelectedChanged = new EventEmitter<string | undefined>();

  constructor(private adb: AdbService) {}

  get all(): Device[] {
    return this.devices;
  }

  get mdns(): MdnsService[] {
    return this.mdnsList;
  }

  get mdnsStatus(): MdnsStatus {
    return this.mdnsStatusState;
  }

  setMdnsStatus(status: MdnsStatus): void {
    this.mdnsStatusState = status;
  }

  setMdns(list: MdnsService[]): void {
    this.mdnsList = list;
    this.onMdnsChanged.fire(list);
  }

  get selected(): Device | undefined {
    return this.devices.find((d) => d.id === this.selectedId);
  }

  getSelectedId(): string | undefined {
    return this.selectedId;
  }

  select(id: string | undefined): void {
    this.selectedId = id;
    this.onSelectedChanged.fire(id);
  }

  remove(id: string): void {
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.selectedId === id) {
      const fallback = this.devices.find((d) => d.state === "connected")?.id;
      this.selectedId = fallback;
      this.onSelectedChanged.fire(fallback);
    }
    this.onDevicesChanged.fire(this.devices);
  }

  /**
   * Reconciles adb discovery with remembered wireless devices.
   * Remembered devices that are not live get state 'disconnected' (Not connected).
   */
  async reconcile(
    remembered: Array<{
      transport: string;
      ipAddress: string;
      port: number;
      name: string;
      hardwareSerial?: string;
    }>
  ): Promise<void> {
    const raw = await this.adb.listDevicesRaw();
    const map = new Map<string, Device>();
    const now = Date.now();

    // Track IPs of all devices that are currently authorized/online
    const onlineIps = new Set<string>();
    for (const row of raw) {
      if (row.state === "authorized") {
        const ip = parseIpPort(row.transport)?.ip;
        if (ip) onlineIps.add(ip);
      }
    }

    // Keep track of offline IPs so we never display multiple offline duplicates for the same device
    const seenOfflineIps = new Set<string>();

    for (const row of raw) {
      const conn: ConnectionType = connectionTypeOf(row.transport);
      const id = row.transport;
      const parsedIp = parseIpPort(row.transport)?.ip;

      // STALE GHOST PRUNING:
      // If a wireless endpoint is offline and the phone is already online (or an earlier offline socket exists for same IP),
      // auto-disconnect the dead socket from ADB and do NOT clutter the UI.
      if (row.state === "offline" && conn === "wireless" && parsedIp) {
        if (onlineIps.has(parsedIp)) {
          void this.adb.disconnect(row.transport);
          continue;
        }
        if (seenOfflineIps.has(parsedIp)) {
          void this.adb.disconnect(row.transport);
          continue;
        }
        seenOfflineIps.add(parsedIp);
      }

      const existing = this.devices.find((d) => d.id === id);

      const parsedPort = parseIpPort(row.transport)?.port;
      const baseName =
        row.model || row.product || row.device || row.transport;

      map.set(id, {
        id,
        transport: row.transport,
        name: existing?.name || baseName,
        model: existing?.model || row.model || "",
        brand: existing?.brand || "",
        androidVersion: existing?.androidVersion || "",
        apiLevel: existing?.apiLevel ?? null,
        connectionType: conn,
        ipAddress: existing?.ipAddress || parsedIp,
        port: parsedPort ?? existing?.port,
        adbState: row.state,
        state: stateFromAdb(row.state),
        batteryLevel: existing?.batteryLevel ?? null,
        isEmulator: conn === "emulator",
        isRemembered: false,
        lastSeen: now,
      });
    }

    // Merge remembered devices that are NOT currently connected
    for (const saved of remembered) {
      // Check if already present in live devices by transport or IP
      const isAlreadyLive = Array.from(map.values()).some(
        (d) =>
          d.transport === saved.transport ||
          (d.ipAddress && d.ipAddress === saved.ipAddress) ||
          d.transport.startsWith(`${saved.ipAddress}:`)
      );

      if (isAlreadyLive) continue;

      const port = parseIpPort(saved.transport)?.port ?? saved.port;
      map.set(saved.transport, {
        id: saved.transport,
        transport: saved.transport,
        name: saved.name || saved.ipAddress,
        model: "",
        brand: "",
        androidVersion: "",
        apiLevel: null,
        connectionType: "wireless",
        ipAddress: saved.ipAddress,
        port,
        adbState: "unknown",
        state: "disconnected", // Label: Not connected
        batteryLevel: null,
        isEmulator: false,
        isRemembered: true,
        lastSeen: now,
      });
    }

    const next = Array.from(map.values()).sort((a, b) => {
      const rank = (d: Device) =>
        (d.state === "connected" ? 0 : 2) + (d.connectionType === "usb" ? 0 : 0.5);
      return rank(a) - rank(b);
    });

    this.devices = next;

    if (this.selectedId && !map.has(this.selectedId)) {
      const fallback = this.devices.find((d) => d.state === "connected")?.id;
      this.selectedId = fallback;
      this.onSelectedChanged.fire(fallback);
    }

    this.onDevicesChanged.fire(this.devices);
  }

  /**
   * Refreshes detailed probe data for connected devices.
   * Never overwrites existing good data with undefined or empty values.
   */
  async refreshDetails(): Promise<void> {
    const targets = this.devices.filter((d) => d.state === "connected");
    await Promise.all(
      targets.map(async (d) => {
        try {
          const info = await this.adb.probeDevice(d.transport);
          const idx = this.devices.findIndex((x) => x.id === d.id);
          if (idx >= 0) {
            const current = this.devices[idx];
            const updated: Device = {
              ...current,
              name: info.name || current.name,
              model: info.model || current.model,
              brand: info.brand || current.brand,
              androidVersion: info.androidVersion || current.androidVersion,
              apiLevel: info.apiLevel !== undefined && info.apiLevel !== null ? info.apiLevel : current.apiLevel,
              ipAddress: info.ipAddress || current.ipAddress,
              batteryLevel: info.batteryLevel !== undefined ? info.batteryLevel : current.batteryLevel,
              lastSeen: Date.now(),
            };
            this.devices[idx] = updated;
          }
        } catch (err) {
          logger.warn("store", `detail probe failed for ${d.id}: ${String(err)}`);
        }
      })
    );
    this.onDevicesChanged.fire(this.devices);
  }

  /**
   * Explicitly disconnects and prunes all offline wireless endpoints.
   */
  async pruneOfflineDevices(): Promise<number> {
    const offlineWireless = this.devices.filter(
      (d) => d.state === "offline" && d.connectionType === "wireless"
    );
    let count = 0;
    for (const d of offlineWireless) {
      try {
        await this.adb.disconnect(d.transport);
        count++;
      } catch {}
    }
    return count;
  }
}