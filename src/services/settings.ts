import * as vscode from "vscode";
import { DeviceHistoryItem } from "../models/types";

export interface ExtensionSettings {
  adbPath: string;
  flutterPath: string;
  autoRefreshMs: number;
  rememberLastDevice: boolean;
  autoReconnect: boolean;
  logLevel: "info" | "warn" | "error";
  screenshotDir: string;
  recordingDir: string;
}

const DEFAULTS: ExtensionSettings = {
  adbPath: "",
  flutterPath: "",
  autoRefreshMs: 5000,
  rememberLastDevice: true,
  autoReconnect: true,
  logLevel: "info",
  screenshotDir: "",
  recordingDir: "",
};

const CONFIG_SECTION = "flutterDeviceManager";

/** Persistent wireless devices saved by stable IP / hardware serial. */
export interface SavedWirelessDevice {
  transport: string;
  ipAddress: string;
  port: number;
  name: string;
  hardwareSerial?: string;
  lastConnected: number;
}

export class Settings {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  get(): ExtensionSettings {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const read = <T>(key: keyof ExtensionSettings, fallback: T): T =>
      cfg.get<T>(key, fallback);
    return {
      adbPath: read("adbPath", DEFAULTS.adbPath),
      flutterPath: read("flutterPath", DEFAULTS.flutterPath),
      autoRefreshMs: read("autoRefreshMs", DEFAULTS.autoRefreshMs),
      rememberLastDevice: read("rememberLastDevice", DEFAULTS.rememberLastDevice),
      autoReconnect: read("autoReconnect", DEFAULTS.autoReconnect),
      logLevel: read("logLevel", DEFAULTS.logLevel),
      screenshotDir: read("screenshotDir", DEFAULTS.screenshotDir),
      recordingDir: read("recordingDir", DEFAULTS.recordingDir),
    };
  }

  // --------------------------------------------------------------------------
  // Persistent state
  // --------------------------------------------------------------------------

  getSavedWirelessDevices(): SavedWirelessDevice[] {
    return this.context.globalState.get<SavedWirelessDevice[]>("savedWireless", []);
  }

  async saveWirelessDevice(device: SavedWirelessDevice): Promise<void> {
    const list = this.getSavedWirelessDevices();
    // Match by stable IP or hardwareSerial if present
    const idx = list.findIndex(
      (d) =>
        (device.hardwareSerial && d.hardwareSerial === device.hardwareSerial) ||
        d.ipAddress === device.ipAddress ||
        d.transport === device.transport
    );
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...device };
    } else {
      list.push(device);
    }
    list.sort((a, b) => b.lastConnected - a.lastConnected);
    const trimmed = list.slice(0, 15);
    await this.context.globalState.update("savedWireless", trimmed);
  }

  async forgetWirelessDevice(transport: string): Promise<void> {
    const list = this.getSavedWirelessDevices().filter(
      (d) => d.transport !== transport && d.ipAddress !== transport
    );
    await this.context.globalState.update("savedWireless", list);
  }

  getLastSelectedDevice(): string | undefined {
    return this.context.globalState.get<string>("lastSelectedDevice");
  }

  async setLastSelectedDevice(id: string | undefined): Promise<void> {
    await this.context.globalState.update("lastSelectedDevice", id);
  }

  /** Project-scoped: last used Flutter run mode per workspace. */
  async getLastRunMode(): Promise<"debug" | "profile" | "release"> {
    const mode = await this.context.workspaceState.get<"debug" | "profile" | "release">(
      "lastRunMode",
      "debug"
    );
    return mode ?? "debug";
  }

  async setLastRunMode(mode: "debug" | "profile" | "release"): Promise<void> {
    await this.context.workspaceState.update("lastRunMode", mode);
  }

  // --------------------------------------------------------------------------
  // Device History Persistence
  // --------------------------------------------------------------------------

  getDeviceHistory(): DeviceHistoryItem[] {
    const raw = this.context.globalState.get<DeviceHistoryItem[]>("deviceHistory", []);
    // Deduplicate in case older versions created duplicate entries
    const seen = new Set<string>();
    const deduplicated: DeviceHistoryItem[] = [];
    for (const item of raw) {
      const key = item.ipAddress || item.transport || item.id;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(item);
      }
    }
    return deduplicated;
  }

  async addToHistory(item: DeviceHistoryItem): Promise<void> {
    const list = this.getDeviceHistory();
    const itemIp = item.ipAddress || (item.transport.includes(":") ? item.transport.split(":")[0] : undefined);

    const idx = list.findIndex((d) => {
      const dIp = d.ipAddress || (d.transport.includes(":") ? d.transport.split(":")[0] : undefined);
      if (itemIp && dIp && itemIp === dIp) return true;
      if (d.id === item.id || d.transport === item.transport) return true;
      if (item.model && d.model && item.model === d.model && item.brand === d.brand) return true;
      return false;
    });

    if (idx >= 0) {
      list[idx] = { ...list[idx], ...item, lastConnected: Date.now() };
    } else {
      list.push({ ...item, lastConnected: Date.now() });
    }
    list.sort((a, b) => b.lastConnected - a.lastConnected);
    const trimmed = list.slice(0, 20);
    await this.context.globalState.update("deviceHistory", trimmed);
  }

  async removeFromHistory(id: string): Promise<void> {
    const list = this.getDeviceHistory().filter((d) => d.id !== id && d.transport !== id);
    await this.context.globalState.update("deviceHistory", list);
  }

  async clearHistory(): Promise<void> {
    await this.context.globalState.update("deviceHistory", []);
  }
}