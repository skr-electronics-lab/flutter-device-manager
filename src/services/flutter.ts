import { exec, stream, StreamHandle } from "../utils/process";
import { resolveFlutterPath, resolveDartPath, workspaceRoot } from "../utils/paths";
import { logger } from "../utils/logger";
import { FlutterProcessStatus, FlutterRunOptions, LogLevel } from "../models/types";
import * as fs from "fs";
import * as path from "path";

export class FlutterNotFoundError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Flutter is not installed or could not be located on PATH. " +
          "Set flutterDeviceManager.flutterPath in VS Code settings to fix this."
    );
    this.name = "FlutterNotFoundError";
  }
}

export type FlutterRunMode = "debug" | "profile" | "release";

export interface FlutterServiceOptions {
  onLog?: (level: LogLevel, message: string) => void;
}

export function classifyLogLevel(line: string): LogLevel {
  const l = line.toLowerCase();
  if (
    /error:|exception|failure|fatal|build failed|gradle.*error|a problem occurred/i.test(
      line
    )
  ) {
    return "error";
  }
  if (/warn|warning:|deprecated/i.test(l)) {
    return "warn";
  }
  return "info";
}

export class FlutterService {
  private flutterPath: string | undefined;
  private onLog: FlutterServiceOptions["onLog"];
  private active: StreamHandle | null = null;
  private runningState: FlutterProcessStatus = "idle";
  private currentAppId: string | null = null;
  private onStateChange?: (status: FlutterProcessStatus, message?: string) => void;

  constructor(options: FlutterServiceOptions = {}) {
    this.refreshPath();
    this.onLog = options.onLog;
  }

  public refreshPath(): void {
    this.flutterPath = resolveFlutterPath();
  }

  private ensure(): string {
    if (!this.flutterPath) {
      throw new FlutterNotFoundError();
    }
    return this.flutterPath;
  }

  get isAvailable(): boolean {
    return !this.flutterPath;
  }

  get isRunning(): boolean {
    return !this.active && this.runningState !== "idle";
  }

  get status(): FlutterProcessStatus {
    return this.runningState;
  }

  setLogSink(fn: FlutterServiceOptions["onLog"]): void {
    this.onLog = fn;
  }

  private logOnce(line: string): void {
    if (!line || !line.trim()) return;
    const level = classifyLogLevel(line);
    this.onLog?.(level, line);
  }

  /** Validates that the active workspace contains a Flutter project. */
  requireWorkspace(): string {
    const root = workspaceRoot();
    if (!root) {
      throw new Error(
        "No workspace folder is open. Please open a Flutter project to use this feature."
      );
    }
    if (!fs.existsSync(path.join(root, "pubspec.yaml"))) {
      throw new Error(
        `The current workspace folder (${path.basename(
          root
        )}) does not contain pubspec.yaml. Open a valid Flutter project.`
      );
    }
    return root;
  }

  /** Runs a one-shot Flutter CLI command, streaming lines without duplicate logs. */
  async runCommand(
    args: string[],
    opts: {
      cwd?: string;
      timeoutMs?: number;
      onLine?: (line: string) => void;
    } = {}
  ): Promise<{ code: number | null; output: string }> {
    const f = this.ensure();
    const cwd = opts.cwd ?? workspaceRoot();
    const fullArgs = [...args, "--no-color"];

    const { code, stdout, stderr } = await exec(f, fullArgs, {
      cwd,
      timeoutMs: opts.timeoutMs ?? 180_000,
      onStdout: (l) => {
        this.logOnce(l);
        opts.onLine?.(l);
      },
      onStderr: (l) => {
        this.logOnce(l);
        opts.onLine?.(l);
      },
    });

    const output = (stdout + stderr).trim();
    return { code, output };
  }

  // --------------------------------------------------------------------------
  // Resident `flutter run` / `flutter attach` with state machine
  // --------------------------------------------------------------------------

  async run(
    options: FlutterRunOptions,
    deviceId: string,
    callbacks: {
      onProgress?: (message: string) => void;
      onState?: (status: FlutterProcessStatus, message?: string) => void;
      onLine?: (line: string) => void;
      onExit?: (code: number | null) => void;
    } = {}
  ): Promise<void> {
    if (this.active) {
      throw new Error("A Flutter application is already running. Stop it before starting a new session.");
    }
    const f = this.ensure();
    const cwd = this.requireWorkspace();

    const args = ["run", "-d", deviceId, `--${options.mode}`, "--no-color", "--machine"];
    if (options.flavor?.trim()) {
      args.push("--flavor", options.flavor.trim());
    }
    if (options.target?.trim()) {
      args.push("-t", options.target.trim());
    }
    if (options.dartDefine && options.dartDefine.length > 0) {
      for (const def of options.dartDefine) {
        if (def.trim()) args.push(`--dart-define=${def.trim()}`);
      }
    }

    logger.info("flutter", `spawning in ${cwd}: flutter ${args.join(" ")}`);

    this.runningState = "starting";
    this.currentAppId = null;
    this.onStateChange = callbacks.onState;
    callbacks.onState?.("starting", "Building application...");

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const markRunning = () => {
        if (this.runningState !== "running") {
          this.runningState = "running";
          callbacks.onState?.("running");
        }
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      const handleLine = (line: string) => {
        callbacks.onLine?.(line);

        // Try parsing JSON machine protocol
        const trimmed = line.trim();
        if (trimmed.startsWith("[{") && trimmed.endsWith("}]")) {
          try {
            const events = JSON.parse(trimmed) as Array<{
              event?: string;
              params?: Record<string, unknown>;
            }>;
            for (const ev of events) {
              if (ev.event === "app.start") {
                this.currentAppId = String(ev.params?.appId ?? "");
                callbacks.onProgress?.("Application starting...");
              } else if (ev.event === "app.progress") {
                const msg = String(ev.params?.message ?? "");
                if (msg) {
                  callbacks.onProgress?.(msg);
                  callbacks.onState?.("starting", msg);
                }
              } else if (ev.event === "app.started") {
                this.currentAppId = String(ev.params?.appId ?? this.currentAppId);
                markRunning();
              } else if (ev.event === "app.stop") {
                this.runningState = "idle";
                this.currentAppId = null;
                callbacks.onState?.("idle");
              } else if (ev.event === "app.log") {
                const logMsg = String(ev.params?.log ?? "");
                if (logMsg) this.logOnce(logMsg);
              }
            }
            return;
          } catch {
            /* fall back to text heuristics */
          }
        }

        // Standard text heuristics fallback
        this.logOnce(line);

        if (
          /syncing files to device|flutter run key commands|an observatory debugger|flutter devtools|to hot reload/i.test(
            line
          )
        ) {
          markRunning();
        } else if (/building|compiling|running gradle task|xcode build/i.test(line)) {
          callbacks.onProgress?.(line.trim());
          callbacks.onState?.("starting", line.trim());
        }
      };

      this.active = stream({
        command: f,
        args,
        cwd,
        onStdout: handleLine,
        onStderr: handleLine,
        onExit: (code) => {
          this.active = null;
          this.currentAppId = null;
          this.runningState = "idle";
          callbacks.onState?.("idle");
          callbacks.onExit?.(code);
          if (!resolved) {
            resolved = true;
            if (code !== 0) {
              reject(new Error(`Flutter run exited early with code ${code}`));
            } else {
              resolve();
            }
          }
        },
      });
    });
  }

  async attach(
    deviceId: string,
    callbacks: {
      onProgress?: (message: string) => void;
      onState?: (status: FlutterProcessStatus, message?: string) => void;
      onLine?: (line: string) => void;
      onExit?: (code: number | null) => void;
    } = {}
  ): Promise<void> {
    if (this.active) {
      throw new Error("A Flutter application is already running. Stop it before attaching.");
    }
    const f = this.ensure();
    const cwd = this.requireWorkspace();
    const args = ["attach", "-d", deviceId, "--no-color", "--machine"];

    logger.info("flutter", `spawning in ${cwd}: flutter ${args.join(" ")}`);

    this.runningState = "starting";
    this.currentAppId = null;
    this.onStateChange = callbacks.onState;
    callbacks.onState?.("starting", "Attaching to device...");

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const markRunning = () => {
        if (this.runningState !== "running") {
          this.runningState = "running";
          callbacks.onState?.("running");
        }
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      const handleLine = (line: string) => {
        callbacks.onLine?.(line);
        const trimmed = line.trim();
        if (trimmed.startsWith("[{") && trimmed.endsWith("}]")) {
          try {
            const events = JSON.parse(trimmed) as Array<{
              event?: string;
              params?: Record<string, unknown>;
            }>;
            for (const ev of events) {
              if (ev.event === "app.started") {
                this.currentAppId = String(ev.params?.appId ?? "");
                markRunning();
              } else if (ev.event === "app.stop") {
                this.runningState = "idle";
                this.currentAppId = null;
                callbacks.onState?.("idle");
              }
            }
            return;
          } catch {}
        }

        this.logOnce(line);
        if (/syncing files|flutter run key commands|attached/i.test(line)) {
          markRunning();
        }
      };

      this.active = stream({
        command: f,
        args,
        cwd,
        onStdout: handleLine,
        onStderr: handleLine,
        onExit: (code) => {
          this.active = null;
          this.currentAppId = null;
          this.runningState = "idle";
          callbacks.onState?.("idle");
          callbacks.onExit?.(code);
          if (!resolved) {
            resolved = true;
            if (code !== 0) {
              reject(new Error(`Flutter attach exited with code ${code}`));
            } else {
              resolve();
            }
          }
        },
      });
    });
  }

  hotReload(): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    if (this.currentAppId) {
      this.active.sendInput(
        `[{"id":10,"method":"app.restart","params":{"appId":"${this.currentAppId}","fullRestart":false}}]\n`
      );
    }
    this.active.sendInput("r\n");
    return Promise.resolve(true);
  }

  hotRestart(): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    if (this.currentAppId) {
      this.active.sendInput(
        `[{"id":20,"method":"app.restart","params":{"appId":"${this.currentAppId}","fullRestart":true}}]\n`
      );
    }
    this.active.sendInput("R\n");
    return Promise.resolve(true);
  }

  async stop(): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    const handle = this.active;
    this.active = null;
    this.runningState = "stopping";
    this.onStateChange?.("stopping", "Stopping application...");

    if (this.currentAppId) {
      handle.sendInput(
        `[{"id":99,"method":"app.stop","params":{"appId":"${this.currentAppId}"}}]\n`
      );
    }
    handle.sendInput("q\n");

    const waitPromise = handle.wait();
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([waitPromise, timeoutPromise]);

    handle.kill();
    this.runningState = "idle";
    this.currentAppId = null;
    this.onStateChange?.("idle");
    return true;
  }

  // --------------------------------------------------------------------------
  // Project commands
  // --------------------------------------------------------------------------

  clean(onLine?: (l: string) => void) {
    const cwd = this.requireWorkspace();
    return this.runCommand(["clean"], { cwd, onLine, timeoutMs: 180_000 });
  }

  pubGet(onLine?: (l: string) => void) {
    const cwd = this.requireWorkspace();
    return this.runCommand(["pub", "get"], { cwd, onLine, timeoutMs: 180_000 });
  }

  pubUpgrade(onLine?: (l: string) => void) {
    const cwd = this.requireWorkspace();
    return this.runCommand(["pub", "upgrade"], { cwd, onLine, timeoutMs: 240_000 });
  }

  doctor(onLine?: (l: string) => void) {
    return this.runCommand(["doctor"], { onLine, timeoutMs: 120_000 });
  }

  async analyze(onLine?: (l: string) => void): Promise<{ code: number | null; output: string }> {
    const cwd = this.requireWorkspace();
    // In flutter analyze, exit code 1 indicates issues were found, not a fatal tool error.
    return this.runCommand(["analyze"], { cwd, onLine, timeoutMs: 180_000 });
  }

  async format(onLine?: (l: string) => void): Promise<{ code: number | null; output: string }> {
    const cwd = this.requireWorkspace();
    const dart = resolveDartPath();
    if (dart) {
      const { code, stdout, stderr } = await exec(dart, ["format", "."], {
        cwd,
        timeoutMs: 120_000,
        onStdout: (l) => {
          this.logOnce(l);
          onLine?.(l);
        },
        onStderr: (l) => {
          this.logOnce(l);
          onLine?.(l);
        },
      });
      return { code, output: (stdout + stderr).trim() };
    }
    return this.runCommand(["format", "."], { cwd, onLine, timeoutMs: 120_000 });
  }
}

let flutterSingleton: FlutterService | null = null;
export function getFlutter(onLog?: FlutterServiceOptions["onLog"]): FlutterService {
  if (!flutterSingleton) {
    flutterSingleton = new FlutterService({ onLog });
  } else if (onLog) {
    flutterSingleton.setLogSink(onLog);
  }
  return flutterSingleton;
}