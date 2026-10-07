import * as vscode from "vscode";
import { SidebarView } from "../ui/panel";
import { ClientMessage } from "../models/types";

/**
 * Registers VS Code commands. Each command forwards its intent to the sidebar's
 * controller if it is available; palette actions also reveal the side view.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  sidebar: SidebarView
): void {
  const forward = (msg: ClientMessage) => {
    void sidebar.controllerRef.handleMessage(msg);
  };

  const register = (id: string, handler: (send: (msg: ClientMessage) => void) => void): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        revealSidebar(id);
        handler(forward);
      })
    );
  };

  register("flutterDeviceManager.openPanel", () => {
    revealSidebar("flutterDeviceManager.openPanel");
  });
  register("flutterDeviceManager.refreshDevices", (f) => f({ type: "devices:refresh" }));
  register("flutterDeviceManager.restartAdb", (f) => f({ type: "adb:restart" }));
  register("flutterDeviceManager.killAdb", (f) => f({ type: "adb:kill" }));
  register("flutterDeviceManager.connectWireless", (f) => f({ type: "wireless:connect" }));
  register("flutterDeviceManager.flutterDoctor", (f) => f({ type: "flutter:doctor" }));
  register("flutterDeviceManager.takeScreenshot", (f) => f({ type: "device:screenshot" }));
}

/** Focus the side view so the user sees the result of a palette action. */
function revealSidebar(_originCommand: string): void {
  void vscode.commands.executeCommand(`${SidebarView.viewType}.focus`);
}