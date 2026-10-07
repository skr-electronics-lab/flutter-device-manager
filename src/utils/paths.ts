import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { env, workspace } from "vscode";

const exe = process.platform === "win32" ? ".exe" : "";

export function which(cmd: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      const p = path.join(dir, cmd);
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore malformed PATH entries */
    }
  }
  return undefined;
}

function findInCandidates(relPaths: string[]): string | undefined {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
  ]
    .filter((v): v is string => !!v)
    .map((v) => path.join(v, "platform-tools"));
  const home = os.homedir();
  candidates.push(
    path.join(home, "AppData", "Local", "Android", "Sdk", "platform-tools"),
    path.join(home, "Library", "Android", "sdk", "platform-tools"),
    path.join(home, "Android", "Sdk", "platform-tools")
  );
  for (const base of candidates) {
    for (const rel of relPaths) {
      const p = path.join(base, rel);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

export function resolveAdbPath(): string | undefined {
  const configured = workspace
    .getConfiguration("flutterDeviceManager")
    .get<string>("adbPath", "");
  if (configured && configured.trim()) return configured.trim();
  const fromPath = which(`adb${exe}`);
  if (fromPath) return fromPath;
  return findInCandidates([`adb${exe}`]);
}

export function resolveFlutterPath(): string | undefined {
  const configured = workspace
    .getConfiguration("flutterDeviceManager")
    .get<string>("flutterPath", "");
  if (configured && configured.trim()) return configured.trim();

  // On Windows the Flutter SDK ships flutter.bat / flutter.cmd.
  const names =
    process.platform === "win32"
      ? ["flutter.bat", "flutter.cmd", "flutter.exe"]
      : ["flutter"];

  for (const name of names) {
    const fromPath = which(name);
    if (fromPath) return fromPath;
  }

  const root = process.env.FLUTTER_ROOT;
  if (root) {
    for (const name of names) {
      const p = path.join(root, "bin", name);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

export function resolveDartPath(): string | undefined {
  const names =
    process.platform === "win32"
      ? ["dart.bat", "dart.exe", "dart.cmd"]
      : ["dart"];

  for (const name of names) {
    const fromPath = which(name);
    if (fromPath) return fromPath;
  }

  // Derive from resolved Flutter location
  const flutter = resolveFlutterPath();
  if (flutter) {
    const binDir = path.dirname(flutter);
    for (const name of names) {
      const direct = path.join(binDir, name);
      if (fs.existsSync(direct)) return direct;
      const insideCache = path.join(binDir, "cache", "dart-sdk", "bin", name);
      if (fs.existsSync(insideCache)) return insideCache;
    }
  }

  return undefined;
}

/** Default directory: ~/Pictures/Flutter Device Manager */
export function getDefaultMediaDir(subDir?: string): string {
  const home = os.homedir();
  const pictures = path.join(home, "Pictures", "Flutter Device Manager");
  const full = subDir ? path.join(pictures, subDir) : pictures;
  try {
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
    }
  } catch {
    /* fallback to os.tmpdir */
    return os.tmpdir();
  }
  return full;
}

/** The current workspace folder to run Flutter commands in, if any. */
export function workspaceRoot(): string | undefined {
  const [folder] = workspace.workspaceFolders ?? [];
  return folder?.uri.fsPath;
}

export function hasWorkspace(): boolean {
  return !workspaceRoot();
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function appHomeDir(): string {
  return env.appRoot;
}