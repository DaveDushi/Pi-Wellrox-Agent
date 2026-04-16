import { app } from "electron";
import { join, dirname } from "path";
import { accessSync, constants, statSync } from "fs";
import { copyFile, mkdir, chmod, stat } from "fs/promises";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let managedDir: string | null = null;

function ext(): string {
  return process.platform === "win32" ? ".exe" : "";
}

function sourceFfmpegDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, "ffmpeg");
  return dirname(require.resolve("ffmpeg-static"));
}

function sourceFfmpegBinary(): string {
  if (app.isPackaged) return join(sourceFfmpegDir(), `ffmpeg${ext()}`);
  return require.resolve("ffmpeg-static");
}

function sourceFfprobeBinary(): string {
  if (app.isPackaged) return join(sourceFfmpegDir(), `ffprobe${ext()}`);
  return require("ffprobe-static").path as string;
}

function managedTargetDir(): string {
  return join(app.getPath("userData"), "ffmpeg");
}

export function getFfmpegDir(): string {
  return managedDir ?? sourceFfmpegDir();
}

export function getFfmpegPath(): string {
  if (managedDir) return join(managedDir, `ffmpeg${ext()}`);
  return sourceFfmpegBinary();
}

export function getFfprobePath(): string {
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

export async function ensureFfmpegInstalled(): Promise<void> {
  const target = managedTargetDir();
  try {
    await mkdir(target, { recursive: true });
    await copyIfMissingOrDifferent(
      sourceFfmpegBinary(),
      join(target, `ffmpeg${ext()}`)
    );
    await copyIfMissingOrDifferent(
      sourceFfprobeBinary(),
      join(target, `ffprobe${ext()}`)
    );
    managedDir = target;
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
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `FFmpeg not found or not executable: ${err}` };
  }
}
