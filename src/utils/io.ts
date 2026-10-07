import type { ClientMessage } from "../models/types";

/**
 * Frame/protocol helpers shared notionally with the webview.
 * The extension host only ever handles ClientMessages from the panel.
 */

export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  return typeof msg.type === "string";
}

let counter = 0;
export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}