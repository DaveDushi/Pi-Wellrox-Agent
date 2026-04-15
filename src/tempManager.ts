import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm } from "fs/promises";

const APP_TEMP_ROOT = join(tmpdir(), "pi-wellrox-agent");
const activeTempDirs = new Set<string>();

export function getTempRoot(): string {
  return APP_TEMP_ROOT;
}

export async function createTempDir(jobId: string): Promise<string> {
  const dir = join(APP_TEMP_ROOT, `frames-${jobId}`);
  await mkdir(dir, { recursive: true });
  activeTempDirs.add(dir);
  return dir;
}

export async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    activeTempDirs.delete(dir);
  } catch (e) {
    console.warn("[tempManager] Failed to clean up:", dir, e);
  }
}

export async function cleanupAllTempDirs(): Promise<void> {
  const dirs = [...activeTempDirs];
  await Promise.allSettled(dirs.map((d) => cleanupTempDir(d)));
}
