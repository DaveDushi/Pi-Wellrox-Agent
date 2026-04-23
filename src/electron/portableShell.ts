import { app } from "electron";
import { existsSync, statSync } from "fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { join, dirname } from "path";

const VERSION_MARKER = ".version";

function sourceGitDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, "git");
  return join(app.getAppPath(), "build", "git");
}

function managedGitDir(): string {
  return join(app.getPath("userData"), "git");
}

export function getStagedBashPath(): string {
  // Use usr/bin/bash.exe — the top-level bin/bash.exe wrapper depends on
  // mingw64/, which we strip from the bundle to save ~100 MB.
  return join(managedGitDir(), "usr", "bin", "bash.exe");
}

/**
 * Directories that must be on PATH for bash to find coreutils (ls, tail, head,
 * cat, grep, sed, awk, etc). Git for Windows' own launcher injects these
 * automatically; we bypass that launcher by spawning bash.exe directly, so we
 * have to inject them ourselves.
 */
export function getShellPathEntries(): string[] {
  if (process.platform !== "win32") return [];
  const root = managedGitDir();
  return [
    join(root, "usr", "bin"),
    join(root, "mingw64", "bin"),
    join(root, "bin"),
  ];
}

/**
 * Prepend the bundled MinGit PATH entries to process.env.PATH so any spawned
 * bash inherits them (pi-coding-agent's getShellEnv() spreads process.env).
 * Idempotent — safe to call more than once.
 */
export function injectShellPathEntries(): void {
  const entries = getShellPathEntries().filter((dir) => existsSync(dir));
  if (entries.length === 0) return;

  const pathKey =
    Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  const current = process.env[pathKey] ?? "";
  const existing = new Set(current.split(sep).filter(Boolean));

  const toAdd = entries.filter((dir) => !existing.has(dir));
  if (toAdd.length === 0) return;

  process.env[pathKey] = [...toAdd, current].filter(Boolean).join(sep);
  console.log(`[portableShell] prepended to PATH: ${toAdd.join(", ")}`);
}

async function readVersion(dir: string): Promise<string | null> {
  try {
    const buf = await readFile(join(dir, VERSION_MARKER), "utf8");
    return buf.trim();
  } catch {
    return null;
  }
}

async function copyTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const s = join(src, entry.name);
      const d = join(dst, entry.name);
      if (entry.isDirectory()) {
        await copyTree(s, d);
      } else if (entry.isFile()) {
        await copyFile(s, d);
      }
    }),
  );
}

async function isStagedAndCurrent(): Promise<boolean> {
  const target = managedGitDir();
  const bash = getStagedBashPath();
  if (!existsSync(bash)) return false;
  try {
    if (statSync(bash).size === 0) return false;
  } catch {
    return false;
  }
  const sourceVersion = await readVersion(sourceGitDir());
  const stagedVersion = await readVersion(target);
  if (!sourceVersion) return true;
  return sourceVersion === stagedVersion;
}

/**
 * Stage the bundled MinGit into userData/git on first run (or after upgrade).
 * Returns the absolute path to bash.exe, or null if not on Windows or staging
 * failed (caller should fall back to letting pi-coding-agent search PATH).
 */
export async function ensurePortableShellInstalled(): Promise<string | null> {
  if (process.platform !== "win32") return null;

  const source = sourceGitDir();
  const target = managedGitDir();

  try {
    await stat(source);
  } catch {
    console.warn(
      `[portableShell] bundled MinGit not found at ${source} — skipping. ` +
        `Run "npm run prepare-git" before building.`,
    );
    return null;
  }

  try {
    if (await isStagedAndCurrent()) {
      console.log(`[portableShell] using staged bash at ${getStagedBashPath()}`);
      return getStagedBashPath();
    }
    console.log(`[portableShell] staging MinGit -> ${target}`);
    await copyTree(source, target);
    const bash = getStagedBashPath();
    if (!existsSync(bash)) {
      throw new Error(`bash.exe not found after staging at ${bash}`);
    }
    return bash;
  } catch (err) {
    console.error("[portableShell] failed to stage MinGit:", err);
    return null;
  }
}

/**
 * Write `shellPath` to pi-coding-agent's settings.json so its `getShellConfig()`
 * uses our bundled bash without searching PATH.
 *
 * pi-coding-agent reads from $PI_CODING_AGENT_DIR (or ~/.pi/agent/) — we set
 * that env var to a per-app directory under userData so we don't pollute the
 * user's global pi-coding-agent settings (if they have one).
 *
 * Only updates the file if `shellPath` differs (so a user-supplied override
 * is not clobbered on next launch).
 */
export async function writeShellPathSetting(bashPath: string): Promise<void> {
  const agentDir = join(app.getPath("userData"), ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const settingsPath = join(agentDir, "settings.json");
  let current: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or unreadable — start fresh
  }

  if (current.shellPath === bashPath) return;

  current.shellPath = bashPath;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(current, null, 2), "utf8");
  console.log(`[portableShell] wrote shellPath -> ${settingsPath}`);
}
