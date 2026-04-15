import { app } from "electron";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { accessSync, constants } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

export function getFfmpegDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "ffmpeg");
  }
  return dirname(require.resolve("ffmpeg-static"));
}

export function getFfmpegPath(): string {
  if (app.isPackaged) {
    const ext = process.platform === "win32" ? ".exe" : "";
    return join(process.resourcesPath, "ffmpeg", `ffmpeg${ext}`);
  }
  return require.resolve("ffmpeg-static");
}

export function getFfprobePath(): string {
  if (app.isPackaged) {
    const ext = process.platform === "win32" ? ".exe" : "";
    return join(process.resourcesPath, "ffmpeg", `ffprobe${ext}`);
  }
  return require("ffprobe-static").path as string;
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
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `FFmpeg not found or not executable: ${err}` };
  }
}
