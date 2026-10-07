import * as vscode from "vscode";

/**
 * Lightweight logger that mirrors diagnostics both to a VS Code Output channel
 * and (optionally) to the in-panel log viewer via a callback sink.
 */

type Sink = (level: "info" | "warn" | "error", message: string) => void;

let channel: vscode.OutputChannel | null = null;
let sink: Sink | null = null;

export function initLogger(outputName: string): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel(outputName);
  return channel;
}

export function setLoggerSink(fn: Sink): void {
  sink = fn;
}

function write(level: "info" | "warn" | "error", tag: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}`;
  channel?.appendLine(line);
  sink?.(level, message);
}

export const logger = {
  info(tag: string, message: string) {
    write("info", tag, message);
  },
  warn(tag: string, message: string) {
    write("warn", tag, message);
  },
  error(tag: string, message: string) {
    write("error", tag, message);
  },
};

/** Friendly, actionable error text for a failed command. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}