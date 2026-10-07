import { spawn, SpawnOptions, ChildProcess } from "child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called with each non-empty captured line as it streams. */
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  /** If provided, writes to the child's stdin. */
  stdin?: string;
}

const ANSI_REGEX =
  /\u001b\[[0-9;]*[a-zA-Z]|\u001b\([a-zA-Z]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g;

/** Strips ANSI escape codes from terminal and CLI output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/** Quote argument safely if it contains spaces or shell metacharacters. */
function quoteIfNeeded(arg: string): string {
  if (arg.length === 0) return '""';
  if (arg.startsWith('"') && arg.endsWith('"')) return arg;
  if (/[\s"&|^<>]/.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

/**
 * Spawns an external tool safely across platforms.
 * On Windows with .bat/.cmd, spawns ComSpec with ["/d", "/s", "/c", '"<cmdline>"']
 * and windowsVerbatimArguments: true to prevent Node double-quoting errors.
 * Otherwise spawns directly without a shell.
 */
export function spawnTool(
  file: string,
  args: string[],
  options: SpawnOptions = {}
): ChildProcess {
  const isWin = process.platform === "win32";
  const isBatch = isWin && /\.(bat|cmd)$/i.test(file);

  if (isBatch) {
    const comspec = process.env.ComSpec || "cmd.exe";
    const cmdLine = [quoteIfNeeded(file), ...args.map(quoteIfNeeded)].join(" ");
    return spawn(comspec, ["/d", "/s", "/c", `"${cmdLine}"`], {
      ...options,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(file, args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: false,
  });
}

/**
 * Kills the process and on Windows forces termination of the entire child tree
 * using `taskkill /pid <pid> /T /F` so orphaned dart/flutter processes don't linger.
 */
export function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    } catch {
      /* fallback to standard kill */
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* noop */
  }
}

/**
 * Runs a command to completion and captures stdout/stderr.
 * Streams lines through callbacks with ANSI codes stripped.
 */
export function exec(
  command: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const child = spawnTool(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let rawStdout = "";
    let rawStderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(`Command timed out after ${timeoutMs}ms.`);
        settle(() => reject(err));
        killTree(child);
      }, timeoutMs);
    }

    const bufferToLines = (chunk: string, existing: string) => {
      const data = existing + chunk;
      const lines = data.split(/\r?\n/);
      const rest = lines.pop() ?? "";
      return { lines, rest };
    };

    let stdoutBuf = "";
    child.stdout?.on("data", (chunk) => {
      const str = String(chunk);
      rawStdout += str;
      stdoutBuf = (() => {
        const { lines, rest } = bufferToLines(str, stdoutBuf);
        for (const line of lines) {
          const clean = stripAnsi(line);
          options.onStdout?.(clean);
        }
        return rest;
      })();
    });

    let stderrBuf = "";
    child.stderr?.on("data", (chunk) => {
      const str = String(chunk);
      rawStderr += str;
      stderrBuf = (() => {
        const { lines, rest } = bufferToLines(str, stderrBuf);
        for (const line of lines) {
          const clean = stripAnsi(line);
          options.onStderr?.(clean);
        }
        return rest;
      })();
    });

    child.on("error", (err) => {
      settle(() => reject(err as Error & { code?: string }));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stdoutBuf) {
        options.onStdout?.(stripAnsi(stdoutBuf));
      }
      if (stderrBuf) {
        options.onStderr?.(stripAnsi(stderrBuf));
      }
      resolve({
        code,
        stdout: stripAnsi(rawStdout),
        stderr: stripAnsi(rawStderr),
      });
    });

    if (child.stdin) {
      if (options.stdin) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    }
  });
}

export interface StreamHandle {
  process: ChildProcess;
  /** Send keyboard input to a resident process (e.g. 'r' hot reload, 'q' quit). */
  sendInput(input: string): void;
  kill(): void;
  wait(): Promise<ExecResult>;
}

/**
 * Spawns a resident process and retains a handle for interactive control.
 * Used for `flutter run` and `flutter attach` so stdin commands can be sent.
 */
export function stream(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null) => void;
}): StreamHandle {
  const child = spawnTool(input.command, input.args, {
    cwd: input.cwd,
    env: input.env ? { ...process.env, ...input.env } : undefined,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  let fullStdout = "";
  const emitter = input.onStdout;
  child.stdout?.on("data", (chunk) => {
    const str = String(chunk);
    fullStdout += str;
    buf += str;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? "";
    if (emitter) {
      for (const p of parts) emitter(stripAnsi(p));
    }
  });

  let stderrBuf = "";
  let fullStderr = "";
  const errEmitter = input.onStderr;
  child.stderr?.on("data", (chunk) => {
    const str = String(chunk);
    fullStderr += str;
    stderrBuf += str;
    const parts = stderrBuf.split(/\r?\n/);
    stderrBuf = parts.pop() ?? "";
    if (errEmitter) {
      for (const p of parts) errEmitter(stripAnsi(p));
    }
  });

  child.on("close", (code) => {
    if (buf && emitter) emitter(stripAnsi(buf));
    if (stderrBuf && errEmitter) errEmitter(stripAnsi(stderrBuf));
    input.onExit?.(code);
  });

  return {
    process: child,
    sendInput(value) {
      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write(value);
        }
      } catch {
        /* process already closed */
      }
    },
    kill() {
      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.end();
        }
      } catch {
        /* noop */
      }
      killTree(child);
    },
    wait() {
      return new Promise<ExecResult>((resolve) => {
        child.on("close", (code) => {
          resolve({
            code,
            stdout: stripAnsi(fullStdout),
            stderr: stripAnsi(fullStderr),
          });
        });
      });
    },
  };
}