import { DeviceStore } from "../state/deviceStore";
import { LogStore } from "../state/logStore";
import { Settings } from "./settings";
import { WirelessService } from "./wireless";
import { AdbService } from "./adb";
import { logger } from "../utils/logger";

/**
 * Coordinates periodic device discovery and reconciliation.
 * Only queries mDNS on demand (e.g. Wireless tab open/refresh) to avoid spinning ADB.
 */
export class DiscoveryService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private disposed = false;
  private refreshing = false;
  private lastErrorShownAt = 0;
  private lastDetailProbeAt = 0;

  constructor(
    private store: DeviceStore,
    private logs: LogStore,
    private settings: Settings,
    private wireless: WirelessService,
    private adb: AdbService
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const settings = this.settings.get();
    if (settings.autoReconnect) {
      void this.wireless.reconnectAll().catch((err) => {
        logger.warn("discovery", `auto-reconnect failed: ${String(err)}`);
      });
    }

    await this.refresh();
    const interval = Math.max(settings.autoRefreshMs, 1000);
    this.timer = setInterval(() => void this.refresh(), interval);
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.refreshing) return;
    this.refreshing = true;
    try {
      const remembered = this.settings.getSavedWirelessDevices();
      await this.store.reconcile(remembered);

      // Probe detailed properties per connected device periodically
      const now = Date.now();
      if (now - this.lastDetailProbeAt >= 15_000) {
        this.lastDetailProbeAt = now;
        await this.store.refreshDetails();
      }
    } catch (err) {
      this.reportError(err);
    } finally {
      this.refreshing = false;
    }
  }

  /** Run mDNS check and scan explicitly (e.g. when Wireless tab is opened). */
  async scanMdns(): Promise<void> {
    try {
      const status = await this.adb.checkMdns();
      this.store.setMdnsStatus(status);
      if (status.available) {
        const services = await this.adb.discoverMdns();
        this.store.setMdns(services);
      } else {
        this.store.setMdns([]);
      }
    } catch (err) {
      logger.warn("discovery", `mDNS scan failed: ${String(err)}`);
    }
  }

  private reportError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("discovery", message);
    const now = Date.now();
    if (now - this.lastErrorShownAt > 30_000) {
      this.lastErrorShownAt = now;
      this.logs.append("error", "system", message);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}