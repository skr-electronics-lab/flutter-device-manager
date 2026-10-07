import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as vscode from "vscode";
import { ServerMessage } from "../models/types";
import { PanelController, ControllerDeps } from "../controller";
import { renderHtml } from "./webviewHtml";
import { logger } from "../utils/logger";

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(16);
  let result = "";
  for (let i = 0; i < bytes.length; i++) result += chars[bytes[i] % chars.length];
  return result;
}

/**
 * Renders the device dashboard as a sidebar view (Activity Bar). Holds a single
 * PanelController for the lifetime of the extension and rebinds its message
 * sink each time the view is (re)resolved.
 */
export class SidebarView implements vscode.WebviewViewProvider {
  public static readonly viewType = "flutterDeviceManager.view";

  private webview: vscode.Webview | undefined;
  private ready = false;
  private pending: ServerMessage[] = [];
  private readonly controller: PanelController;

  constructor(private readonly context: vscode.ExtensionContext, deps: ControllerDeps) {
    this.controller = new PanelController(deps, (msg) => this.post(msg));
  }

  get controllerRef(): PanelController {
    return this.controller;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webview = webviewView.webview;
    this.ready = false;
    this.pending = [];
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this.buildHtml();

    webviewView.webview.onDidReceiveMessage((message) => {
      // First message proves the webview is alive; safe to flush buffered state.
      this.markReady();
      void this.controller.handleMessage(message);
    });
  }

  private buildHtml(): string {
    const scriptPath = path.join(this.context.extensionPath, "dist", "webview", "main.js");
    const cssPath = path.join(this.context.extensionPath, "dist", "webview", "main.css");
    const nonce = generateNonce();
    try {
      const script = fs.readFileSync(scriptPath, "utf8");
      const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : "";
      return renderHtml(nonce, script, css);
    } catch (err) {
      logger.error("panel", `webview bundle missing: ${String(err)}`);
      return renderHtml(
        nonce,
        "document.getElementById('app').textContent='Panel bundle missing. Build the extension first (npm run build).';",
        ""
      );
    }
  }

  private post(message: ServerMessage): void {
    if (!this.webview) return;
    if (!this.ready) {
      this.pending.push(message);
      return;
    }
    void this.webview.postMessage(message);
  }

  private markReady(): void {
    this.ready = true;
    if (!this.webview) return;
    for (const msg of this.pending) {
      void this.webview.postMessage(msg);
    }
    this.pending = [];
  }
}