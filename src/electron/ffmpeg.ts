import { app } from "electron";
import { join, dirname } from "path";
import { accessSync, constants, existsSync, readdirSync, statSync } from "fs";
import { copyFile, mkdir, chmod, stat } from "fs/promises";
import { createRequire } from "module";
import { spawnSync } from "child_process";

const require = createRequire(import.meta.url);

let managedDir: string | null = null;
let resolvedFfmpegPath: string | null = null;
let resolvedFfprobePath: string | null = null;

function ext(): string {
  return process.platform === "win32" ? ".exe" : "";
}

function sourceFfmpegDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, "ffmpeg");
  // require("ffmpeg-static") evaluates the module and returns the absolute
  // path to the actual binary. require.resolve() would return index.js — a JS
  // shim — which is NOT a runnable binary.
  return dirname(require("ffmpeg-static") as string);
}

function sourceFfmpegBinary(): string {
  if (app.isPackaged) return join(sourceFfmpegDir(), `ffmpeg${ext()}`);
  return require("ffmpeg-static") as string;
}

function sourceFfprobeBinary(): string {
  if (app.isPackaged) return join(sourceFfmpegDir(), `ffprobe${ext()}`);
  return require("ffprobe-static").path as string;
}

function managedTargetDir(): string {
  return join(app.getPath("userData"), "ffmpeg");
}

export function getFfmpegDir(): string {
  if (resolvedFfmpegPath) return dirname(resolvedFfmpegPath);
  return managedDir ?? sourceFfmpegDir();
}

export function getFfmpegPath(): string {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;
  if (managedDir) return join(managedDir, `ffmpeg${ext()}`);
  return sourceFfmpegBinary();
}

export function getFfprobePath(): string {
  if (resolvedFfprobePath) return resolvedFfprobePath;
  if (managedDir) return join(managedDir, `ffprobe${ext()}`);
  return sourceFfprobeBinary();
}

async function copyIfMissingOrDifferent(
  src: string,
  dst: string
): Promise<void> {
  let srcStat: Awaited<ReturnType<typeof stat>>;
  try {
    srcStat = await stat(src);
  } catch (err) {
    throw new Error(`Source FFmpeg binary missing: ${src}: ${err}`);
  }

  try {
    const dstStat = await stat(dst);
    if (dstStat.size === srcStat.size) return;
  } catch {
    // destination missing — fall through to copy
  }

  await copyFile(src, dst);
  if (process.platform !== "win32") {
    await chmod(dst, 0o755);
  }
}

function probeFfmpeg(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const result = spawnSync(path, ["-version"], {
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) return false;
    const out = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
    return /ffmpeg version/i.test(out);
  } catch {
    return false;
  }
}

function whichFfmpeg(): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  try {
    const result = spawnSync(cmd, [name], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return null;
    for (const line of result.stdout.trim().split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && existsSync(candidate)) return candidate;
    }
  } catch {
    // fall through
  }
  return null;
}

function commonWindowsFfmpegPaths(): string[] {
  if (process.platform !== "win32") return [];
  const candidates: string[] = [];
  const programFiles = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ].filter((p): p is string => !!p);

  for (const base of programFiles) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!/^ffmpeg/i.test(entry.name)) continue;
        candidates.push(join(base, entry.name, "bin", "ffmpeg.exe"));
        candidates.push(join(base, entry.name, "ffmpeg.exe"));
      }
    } catch {
      // directory unreadable — skip
    }
    candidates.push(join(base, "ffmpeg", "bin", "ffmpeg.exe"));
  }

  candidates.push("C:\\ffmpeg\\bin\\ffmpeg.exe");

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      for (const entry of readdirSync(wingetPackages, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!/ffmpeg/i.test(entry.name)) continue;
        const pkgDir = join(wingetPackages, entry.name);
        try {
          for (const sub of readdirSync(pkgDir, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            candidates.push(join(pkgDir, sub.name, "bin", "ffmpeg.exe"));
          }
        } catch {}
      }
    } catch {}
  }

  const choco = process.env.ChocolateyInstall;
  if (choco) candidates.push(join(choco, "bin", "ffmpeg.exe"));

  return candidates;
}

function pairedFfprobe(ffmpegPath: string): string | null {
  const dir = dirname(ffmpegPath);
  const probe = join(dir, `ffprobe${ext()}`);
  return probeFfmpeg(probe) ? probe : null;
}

function detectSystemFfmpeg(): { ffmpeg: string; ffprobe: string | null } | null {
  const envOverride = process.env.FFMPEG_PATH;
  if (envOverride && probeFfmpeg(envOverride)) {
    return { ffmpeg: envOverride, ffprobe: pairedFfprobe(envOverride) };
  }

  const onPath = whichFfmpeg();
  if (onPath && probeFfmpeg(onPath)) {
    return { ffmpeg: onPath, ffprobe: pairedFfprobe(onPath) };
  }

  for (const candidate of commonWindowsFfmpegPaths()) {
    if (probeFfmpeg(candidate)) {
      return { ffmpeg: candidate, ffprobe: pairedFfprobe(candidate) };
    }
  }

  return null;
}

export async function ensureFfmpegInstalled(): Promise<void> {
  // 1. Prefer a working system ffmpeg if one is installed.
  const detected = detectSystemFfmpeg();
  if (detected) {
    resolvedFfmpegPath = detected.ffmpeg;
    if (detected.ffprobe) {
      resolvedFfprobePath = detected.ffprobe;
      console.log(`[ffmpeg] using system ffmpeg at ${detected.ffmpeg}`);
      return;
    }
    console.log(
      `[ffmpeg] using system ffmpeg at ${detected.ffmpeg}; falling back to bundled ffprobe`
    );
  }

  // 2. Stage the bundled binaries into userData (install-on-first-run).
  const target = managedTargetDir();
  try {
    await mkdir(target, { recursive: true });
    const stagedFfmpeg = join(target, `ffmpeg${ext()}`);
    const stagedFfprobe = join(target, `ffprobe${ext()}`);

    await copyIfMissingOrDifferent(sourceFfmpegBinary(), stagedFfmpeg);
    await copyIfMissingOrDifferent(sourceFfprobeBinary(), stagedFfprobe);

    // Verify the staged ffmpeg actually runs. If a previous version of the
    // app copied a bad file (e.g., the ffmpeg-static JS shim), re-copy from
    // source and retry once before giving up.
    if (!probeFfmpeg(stagedFfmpeg)) {
      console.warn(
        `[ffmpeg] staged ffmpeg failed -version probe; re-copying from source`
      );
      await copyFile(sourceFfmpegBinary(), stagedFfmpeg);
      if (process.platform !== "win32") await chmod(stagedFfmpeg, 0o755);
      if (!probeFfmpeg(stagedFfmpeg)) {
        throw new Error(
          `Staged ffmpeg at ${stagedFfmpeg} does not run (source may be corrupted).`
        );
      }
    }

    managedDir = target;
    if (!resolvedFfprobePath) {
      resolvedFfprobePath = stagedFfprobe;
    }
    if (!resolvedFfmpegPath) {
      resolvedFfmpegPath = stagedFfmpeg;
    }
    console.log(`[ffmpeg] using managed binaries at ${target}`);
  } catch (err) {
    console.error(
      "[ffmpeg] failed to stage managed binaries, falling back to source path:",
      err
    );
    managedDir = null;
  }
}

export function injectFfmpegIntoPath(): void {
  const ffmpegDir = getFfmpegDir();
  const pathKey =
    Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  const current = process.env[pathKey] ?? "";

  if (!current.split(sep).includes(ffmpegDir)) {
    process.env[pathKey] = `${ffmpegDir}${sep}${current}`;
  }
}

export function verifyFfmpeg(): { ok: true } | { ok: false; error: string } {
  try {
    const p = getFfmpegPath();
    accessSync(p, constants.X_OK);
    const s = statSync(p);
    if (!s.size) {
      return { ok: false, error: `FFmpeg binary at ${p} is empty` };
    }
    if (!probeFfmpeg(p)) {
      return {
        ok: false,
        error: `FFmpeg binary at ${p} did not respond to "-version" (likely not a valid executable).`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `FFmpeg not found or not executable: ${err}` };
  }
}
