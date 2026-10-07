import { EventEmitter } from "vscode";
import { LogEntry, LogLevel } from "../models/types";
import { uid } from "../utils/io";

const MAX_ENTRIES = 3000;
const FLUSH_INTERVAL_MS = 100;

/**
 * Ring-buffer backed log store.
 * Batches webview flushes every ~100ms and collapses consecutive duplicate lines with a count.
 */
export class LogStore {
  private entries: LogEntry[] = [];
  private paused = false;
  private pendingBatch: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  readonly onChange = new EventEmitter<LogEntry[]>();
  readonly onBatch = new EventEmitter<LogEntry[]>();

  get all(): LogEntry[] {
    return this.entries;
  }

  append(level: LogLevel, source: LogEntry["source"], message: string): void {
    if (!message || !message.trim()) return;

    if (this.paused) return;

    // Check consecutive duplicate collapsing
    const last = this.entries[this.entries.length - 1];
    if (
      last &&
      last.level === level &&
      last.source === source &&
      last.message === message
    ) {
      last.count = (last.count || 1) + 1;
      last.timestamp = Date.now();
      // Ensure the updated entry is part of pending batch
      if (!this.pendingBatch.includes(last)) {
        this.pendingBatch.push(last);
      }
      this.scheduleFlush();
      return;
    }

    const entry: LogEntry = {
      id: uid("log"),
      timestamp: Date.now(),
      level,
      source,
      message,
      count: 1,
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }

    this.pendingBatch.push(entry);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pendingBatch.length > 0) {
        const batch = [...this.pendingBatch];
        this.pendingBatch = [];
        this.onBatch.fire(batch);
      }
    }, FLUSH_INTERVAL_MS);
  }

  setPaused(paused: boolean): LogEntry[] {
    this.paused = paused;
    return this.entries;
  }

  isPaused(): boolean {
    return this.paused;
  }

  clear(): void {
    this.entries = [];
    this.pendingBatch = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.onChange.fire(this.entries);
  }

  exportText(): string {
    return this.entries
      .map((e) => {
        const time = new Date(e.timestamp).toISOString();
        const multiplier = e.count && e.count > 1 ? ` (×${e.count})` : "";
        return `[${time}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}${multiplier}`;
      })
      .join("\n");
  }
}