import * as vscode from "vscode";
import { randomBytes } from "crypto";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";
import { AdbService, parseIpPort } from "./adb";
import { Settings } from "./settings";
import { logger } from "../utils/logger";
import { QrPhase } from "../models/types";
import { MdnsListener, DiscoveredMdnsEndpoint } from "../utils/mdns";

const IP_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/;
const QR_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const QR_POLL_MS = 2000;
const QR_WATCH_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomId(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += QR_ALPHABET[bytes[i] % QR_ALPHABET.length];
  return out;
}

export interface PairRequest {
  host: string;
  port: number;
  code: string;
  connectPort?: number;
}

export interface ConnectRequest {
  transport: string;
}

export type WirelessResult = { ok: true; message: string } | { ok: false; error: string };

function isValidIp(ip: string): boolean {
  const parts = ip.split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    })
  );
}

function validateHostPort(host: string, port: number): string | null {
  if (!host || !isValidIp(host)) {
    return "Invalid IP address. Enter an address like 192.168.1.42.";
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Invalid port. Use a value between 1 and 65535.";
  }
  return null;
}

function isProtocolFault(output: string): boolean {
  return /protocol fault/i.test(output);
}

function isUnreachable(output: string): boolean {
  return /(?:failed to connect|cannot connect|unable to connect|connection refused|timed out|no route to host)/i.test(
    output
  );
}

function pairingGuidance(): string {
  return (
    "Pairing failed. Make sure you entered the specific 'Port for pairing' shown on the " +
    "'Pair device with pairing code' dialog (NOT the main connect port). Ensure the screen " +
    "stays on with the dialog visible. Pairing codes expire after about 60 seconds."
  );
}

function connectGuidance(transport: string): string {
  return (
    `Could not connect to ${transport}. Verify that Wireless Debugging is enabled on the device, ` +
    "both devices are on the same Wi-Fi network, and you are using the main Connect Port."
  );
}

export class WirelessService {
  private pythonProc: ChildProcess | null = null;
  private qrActive = false;
  private qrCancelled = false;
  private qrPassword = "";
  private qrName = "";
  private qrExpiresAt = 0;

  constructor(private adb: AdbService, private settings: Settings) {}

  // --------------------------------------------------------------------------
  // QR-code pairing (Standard Wi-Fi schema matching Android Studio / adb-connect-qr)
  // --------------------------------------------------------------------------

  beginQrSession(): { payload: string; expiresAt: number } {
    if (this.qrActive) {
      throw new Error("A QR pairing session is already running. Cancel it or wait for it to finish.");
    }
    this.qrActive = true;
    this.qrCancelled = false;
    this.qrName = `adb-cli-${randomId(6)}`;
    this.qrPassword = randomId(6);
    this.qrExpiresAt = Date.now() + QR_WATCH_MS;
    logger.info("wireless", `started QR pairing session ${this.qrName} (pin: ${this.qrPassword})`);
    return {
      payload: `WIFI:T:ADB;S:${this.qrName};P:${this.qrPassword};;`,
      expiresAt: this.qrExpiresAt,
    };
  }

  cancelQrSession(): void {
    this.qrCancelled = true;
    if (this.pythonProc) {
      try {
        this.pythonProc.kill();
      } catch {}
      this.pythonProc = null;
    }
    this.qrActive = false;
    logger.info("wireless", "cancelled QR pairing session");
  }

  private findBridgeScript(): string | null {
    const candidates = [
      path.resolve(__dirname, "..", "scripts", "adb_qr_bridge.py"),
      path.resolve(__dirname, "scripts", "adb_qr_bridge.py"),
      path.resolve(__dirname, "..", "..", "scripts", "adb_qr_bridge.py"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  async awaitQrPairing(
    onStatus: (phase: QrPhase, message: string) => void
  ): Promise<WirelessResult> {
    const bridgePath = this.findBridgeScript();

    if (bridgePath) {
      try {
        const pyResult = await this.runPythonBridge(bridgePath, onStatus);
        if (pyResult !== null) return pyResult;
      } catch (err) {
        logger.warn("wireless", `python bridge error, falling back to native listener: ${err}`);
      }
    }

    return await this.awaitQrPairingNative(onStatus);
  }

  private runPythonBridge(
    bridgePath: string,
    onStatus: (phase: QrPhase, message: string) => void
  ): Promise<WirelessResult | null> {
    return new Promise((resolve) => {
      onStatus("waiting", "Waiting for phone to scan the QR code\u2026");
      const adbPath = this.settings.get().adbPath || "adb";
      const proc = spawn(
        "python",
        [
          bridgePath,
          "--name",
          this.qrName,
          "--password",
          this.qrPassword,
          "--timeout",
          "60",
          "--adb-path",
          adbPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );

      this.pythonProc = proc;
      let finalResult: WirelessResult | null = null;

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        try {
          const data = JSON.parse(line.trim());
          if (data.status === "waiting") {
            onStatus("waiting", data.message || "Waiting for phone to scan the QR code\u2026");
          } else if (data.status === "device_found") {
            onStatus("pairing", data.message || `Pairing with ${data.ip}:${data.port}\u2026`);
          } else if (data.status === "paired") {
            onStatus("connecting", data.message || "Paired! Connecting\u2026");
          } else if (data.status === "connecting") {
            onStatus("connecting", data.message || `Connecting to ${data.ip}:${data.port}\u2026`);
          } else if (data.status === "connected" || data.status === "paired_only") {
            finalResult = { ok: true, message: data.message };
          } else if (
            data.status === "error" ||
            data.status === "timeout" ||
            data.status === "pair_failed" ||
            data.status === "connect_failed"
          ) {
            finalResult = { ok: false, error: data.message || data.error };
          }
        } catch {}
      });

      proc.on("error", () => {
        this.pythonProc = null;
        resolve(null);
      });

      proc.on("close", (code) => {
        this.pythonProc = null;
        this.qrActive = false;
        if (code === 2) {
          resolve(null);
        } else if (finalResult) {
          resolve(finalResult);
        } else if (this.qrCancelled) {
          resolve({ ok: false, error: "QR pairing cancelled." });
        } else {
          resolve({ ok: false, error: "QR pairing timed out or could not complete." });
        }
      });
    });
  }

  private async awaitQrPairingNative(
    onStatus: (phase: QrPhase, message: string) => void
  ): Promise<WirelessResult> {
    const mdnsListener = new MdnsListener();
    const capturedEndpoints: DiscoveredMdnsEndpoint[] = [];

    try {
      mdnsListener.start((ep) => {
        capturedEndpoints.push(ep);
      });

      onStatus("waiting", "Waiting for phone to scan the QR code\u2026");
      let pairingTarget: { ip: string; port: number } | null = null;

      const initialServices = await this.adb.discoverMdns();
      const initialTargets = new Set(
        initialServices.filter((s) => s.type === "pairing").map((s) => s.target)
      );

      while (Date.now() < this.qrExpiresAt) {
        if (this.qrCancelled) return { ok: false, error: "QR pairing cancelled." };

        mdnsListener.query("_adb-tls-pairing._tcp.local");

        const localPairing = capturedEndpoints.filter((s) => s.type === "pairing");
        const name = this.qrName.toLowerCase();
        let match = localPairing.find((s) => s.name.toLowerCase() === name);
        if (!match) {
          match = localPairing.find((s) => s.name.toLowerCase().startsWith("adb-"));
        }
        if (!match && localPairing.length > 0) {
          match = localPairing[localPairing.length - 1];
        }

        if (match) {
          pairingTarget = { ip: match.ip, port: match.port };
          break;
        }

        const services = await this.adb.discoverMdns();
        const currentPairing = services.filter((s) => s.type === "pairing");
        let adbMatch = currentPairing.find((s) => s.name.toLowerCase() === name);
        if (!adbMatch) {
          adbMatch = currentPairing.find(
            (s) => s.name.toLowerCase().startsWith("adb-") || s.name.toLowerCase().startsWith("studio-")
          );
        }
        if (!adbMatch) {
          adbMatch = currentPairing.find((s) => !initialTargets.has(s.target));
        }
        if (!adbMatch && currentPairing.length === 1) {
          adbMatch = currentPairing[0];
        }

        if (adbMatch) {
          const parsed = parseIpPort(adbMatch.target);
          if (parsed) {
            pairingTarget = parsed;
            break;
          }
        }
        await sleep(QR_POLL_MS);
      }

      if (!pairingTarget) {
        return {
          ok: false,
          error: "No device scanned the QR code. Keep the 'Pair device with QR code' dialog open on phone and try again.",
        };
      }
      if (this.qrCancelled) return { ok: false, error: "QR pairing cancelled." };

      onStatus("pairing", `Pairing with ${pairingTarget.ip}:${pairingTarget.port}\u2026`);
      const first = await this.safePair(pairingTarget.ip, pairingTarget.port, this.qrPassword);
      if (!first.ok) {
        if (isProtocolFault(first.message)) {
          const retried = await this.recoverAndRetry("QR pairing", () =>
            this.adb.pair(pairingTarget!.ip, pairingTarget!.port, this.qrPassword)
          );
          if (!retried?.ok) return { ok: false, error: pairingGuidance() };
        } else {
          return { ok: false, error: first.message || pairingGuidance() };
        }
      }

      onStatus("connecting", `Paired! Connecting to ${pairingTarget.ip}\u2026`);
      const connectDeadline = Date.now() + 30_000;
      while (Date.now() < connectDeadline) {
        if (this.qrCancelled) return { ok: false, error: "QR pairing cancelled." };

        mdnsListener.query("_adb-tls-connect._tcp.local");

        try {
          const raw = await this.adb.listDevicesRaw();
          const already = raw.find(
            (d) => d.state === "authorized" && d.transport.startsWith(`${pairingTarget!.ip}:`)
          );
          if (already) {
            await this.saveConnected(pairingTarget.ip, parseIpPort(already.transport)?.port ?? 5555, already.transport);
            return { ok: true, message: `Paired and connected to ${already.transport}.` };
          }
        } catch {}

        const localConn = capturedEndpoints.find(
          (s) => s.type === "connect" && s.ip === pairingTarget!.ip
        );
        if (localConn) {
          const result = await this.connect(`${localConn.ip}:${localConn.port}`);
          if (result.ok) {
            return { ok: true, message: `Paired and connected to ${localConn.ip}:${localConn.port}.` };
          }
        }

        const services = await this.adb.discoverMdns();
        const conn =
          services.find((s) => s.type === "connect" && s.target.startsWith(`${pairingTarget!.ip}:`)) ||
          services.find((s) => s.type === "connect");
        if (conn) {
          const result = await this.connect(conn.target);
          if (result.ok) {
            return { ok: true, message: `Paired and connected to ${conn.target}.` };
          }
        }
        await sleep(QR_POLL_MS);
      }

      return {
        ok: true,
        message: `Paired successfully with ${pairingTarget.ip}! If not connected automatically, connect using the port shown on your phone.`,
      };
    } finally {
      this.qrActive = false;
      this.qrCancelled = false;
      mdnsListener.stop();
    }
  }

  private async recoverAndRetry<T extends { ok: boolean; message: string }>(
    label: string,
    attempt: () => Promise<T>
  ): Promise<T | null> {
    logger.warn("wireless", `${label} hit protocol fault. Restarting ADB server...`);
    try {
      await this.adb.serverRestart();
      await sleep(1200);
      return await attempt();
    } catch (err) {
      logger.error("wireless", `${label} retry failed: ${String(err)}`);
      return null;
    }
  }

  async pairWithCode(request: PairRequest): Promise<WirelessResult> {
    const invalid = validateHostPort(request.host, request.port);
    if (invalid) return { ok: false, error: invalid };
    const code = request.code.trim();
    if (!/^\d{6}$/.test(code)) {
      return { ok: false, error: "Pairing code must be exactly 6 digits." };
    }

    let pairOk = false;
    const first = await this.safePair(request.host, request.port, code);
    if (first.ok) {
      pairOk = true;
    } else if (isProtocolFault(first.message)) {
      const retried = await this.recoverAndRetry("pairing", () =>
        this.adb.pair(request.host, request.port, code)
      );
      if (retried?.ok) pairOk = true;
    }

    if (!pairOk) {
      if (isUnreachable(first.message)) {
        return { ok: false, error: `ADB could not reach ${request.host}:${request.port}. ${pairingGuidance()}` };
      }
      return { ok: false, error: first.message || pairingGuidance() };
    }

    if (request.connectPort && request.connectPort > 0 && request.connectPort <= 65535) {
      const conn = await this.connect(`${request.host}:${request.connectPort}`);
      if (conn.ok) {
        return { ok: true, message: `Paired and connected to ${request.host}:${request.connectPort}!` };
      }
      return {
        ok: true,
        message: `Paired successfully! Connect manually using the port displayed on your phone's screen.`,
      };
    }

    // Auto-detect connect port via mDNS or device scan
    for (let i = 0; i < 4; i++) {
      await sleep(1000);
      try {
        const services = await this.adb.discoverMdns();
        const connService = services.find(
          (s) => s.type === "connect" && s.target.startsWith(`${request.host}:`)
        );
        if (connService) {
          const res = await this.connect(connService.target);
          if (res.ok) {
            return { ok: true, message: `Paired and connected to ${connService.target}!` };
          }
        }
      } catch {}
    }

    return {
      ok: true,
      message: `Device paired with ${request.host}! Enter the Connect Port shown on your phone's screen to finish connecting.`,
    };
  }

  private async safePair(
    host: string,
    port: number,
    code: string
  ): Promise<{ ok: boolean; message: string }> {
    try {
      return await this.adb.pair(host, port, code);
    } catch (err: unknown) {
      return { ok: false, message: String(err) };
    }
  }

  async connect(transport: string): Promise<WirelessResult> {
    const parsed = parseIpPort(transport);
    if (!parsed) {
      return { ok: false, error: "Enter an address in the form ip:port." };
    }
    const invalid = validateHostPort(parsed.ip, parsed.port);
    if (invalid) return { ok: false, error: invalid };

    const first = await this.safeConnect(transport);
    if (first.ok) {
      await this.saveConnected(parsed.ip, parsed.port, transport);
      return { ok: true, message: `Connected to ${transport}` };
    }

    if (isProtocolFault(first.message)) {
      const retried = await this.recoverAndRetry("connect", () => this.adb.connect(transport));
      if (retried?.ok) {
        await this.saveConnected(parsed.ip, parsed.port, transport);
        return { ok: true, message: `Connected to ${transport} after restarting ADB.` };
      }
      return { ok: false, error: connectGuidance(transport) };
    }

    return { ok: false, error: first.message || connectGuidance(transport) };
  }

  private async safeConnect(transport: string): Promise<{ ok: boolean; message: string }> {
    try {
      return await this.adb.connect(transport);
    } catch (err: unknown) {
      return { ok: false, message: String(err) };
    }
  }

  private async saveConnected(ip: string, port: number, transport: string): Promise<void> {
    try {
      // Probe to get device name and stable hardware serial
      const info = await this.adb.probeDevice(transport);
      await this.settings.saveWirelessDevice({
        transport,
        ipAddress: ip,
        port,
        name: info.name || ip,
        hardwareSerial: info.transport || undefined,
        lastConnected: Date.now(),
      });
    } catch (err) {
      logger.warn("wireless", `failed to save wireless device ${transport}: ${String(err)}`);
    }
  }

  async enableTcpip(port: number, usbSerial?: string): Promise<WirelessResult> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: "Invalid port. Use a value between 1 and 65535." };
    }
    const result = await this.adb.tcpip(port, usbSerial);
    if (result.ok) {
      return {
        ok: true,
        message: `ADB listening on TCP port ${port}. You may unplug USB and connect to this device over Wi-Fi.`,
      };
    }
    return { ok: false, error: result.message || "Failed to switch ADB to TCP/IP mode." };
  }

  async disconnect(transport: string): Promise<void> {
    await this.adb.disconnect(transport);
  }

  /**
   * Reconnects remembered devices.
   * Resolves current port via `adb mdns services` (_adb-tls-connect) before falling back to saved port.
   */
  async reconnectAll(): Promise<void> {
    const saved = this.settings.getSavedWirelessDevices();
    if (saved.length === 0) return;

    let mdnsServices: import("../models/types").MdnsService[] = [];
    try {
      mdnsServices = await this.adb.discoverMdns();
    } catch {}

    await Promise.all(
      saved.map(async (device) => {
        // Check if an mDNS connect service exists for this IP
        const matchedMdns = mdnsServices.find(
          (s) => s.type === "connect" && s.target.startsWith(`${device.ipAddress}:`)
        );
        const targetTransport = matchedMdns ? matchedMdns.target : device.transport;

        try {
          const res = await this.adb.connect(targetTransport, 6000);
          if (res.ok) {
            const parsed = parseIpPort(targetTransport);
            if (parsed) {
              await this.saveConnected(parsed.ip, parsed.port, targetTransport);
            }
          }
        } catch {}
      })
    );
  }

  async forget(transport: string): Promise<void> {
    await this.settings.forgetWirelessDevice(transport);
    try {
      await this.adb.disconnect(transport);
    } catch {}
  }

  async promptConnect(): Promise<ConnectRequest | null> {
    const transport = await vscode.window.showInputBox({
      prompt: "Enter device address (for example 192.168.1.42:5555)",
      placeHolder: "192.168.1.42:5555",
      validateInput: (value) => {
        const m = IP_PORT.exec(value.trim());
        if (!m) return "Address must be in the format ip:port.";
        return validateHostPort(m[1], Number(m[2]));
      },
    });
    if (!transport) return null;
    return { transport: transport.trim() };
  }
}