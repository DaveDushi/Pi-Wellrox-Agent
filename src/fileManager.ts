import { join } from "path";
import { mkdir } from "fs/promises";
import { getDataDir } from "./paths.js";

export let UPLOAD_DIR = join(getDataDir(), "uploads");
export let OUTPUT_DIR = join(getDataDir(), "output");
export const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

export async function ensureDirectories(): Promise<void> {
  UPLOAD_DIR = join(getDataDir(), "uploads");
  OUTPUT_DIR = join(getDataDir(), "output");
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
}

export function generateJobId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export function getUploadPath(filename: string): string {
  return join(UPLOAD_DIR, filename);
}

export function getOutputPath(jobId: string): string {
  return join(OUTPUT_DIR, `result-${jobId}.mp4`);
}

export function getOutputFilename(jobId: string): string {
  return `result-${jobId}.mp4`;
}
