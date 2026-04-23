import { join } from "path";
import { readdir, readFile, writeFile, stat } from "fs/promises";
import { UPLOAD_DIR, OUTPUT_DIR } from "./fileManager.js";
import { getUserDataDir } from "./paths.js";

export interface MediaItem {
  id: string;
  filename: string;
  type: "upload" | "output";
  label: string;
  originalName?: string;
  parentIds?: string[];
  createdAt: number;
  url: string;
  description?: string;
  duration?: number;
  inPoint?: number;
  outPoint?: number;
}

function sidecarPath(): string {
  return join(getUserDataDir(), "media-meta.json");
}

const items = new Map<string, MediaItem>();
let writeChain: Promise<void> = Promise.resolve();

async function loadSidecar(): Promise<Record<string, MediaItem>> {
  try {
    const raw = await readFile(sidecarPath(), "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.warn("[mediaRegistry] Failed to load sidecar:", e);
    return {};
  }
}

function saveSidecar(): Promise<void> {
  writeChain = writeChain.then(async () => {
    const obj: Record<string, MediaItem> = {};
    for (const [id, item] of items) {
      obj[id] = item;
    }
    await writeFile(sidecarPath(), JSON.stringify(obj, null, 2));
  }).catch((e) => {
    console.warn("[mediaRegistry] Failed to save sidecar:", e);
  });
  return writeChain;
}

async function fileCreatedAt(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.mtimeMs || Date.now();
  } catch {
    return Date.now();
  }
}

export async function scanDisk(): Promise<void> {
  let changed = false;
  const seen = new Set<string>();

  try {
    const uploadFiles = await readdir(UPLOAD_DIR);
    for (const f of uploadFiles) {
      const id = f.split(".")[0];
      seen.add(id);
      if (!items.has(id)) {
        items.set(id, {
          id,
          filename: f,
          type: "upload",
          label: f,
          createdAt: await fileCreatedAt(join(UPLOAD_DIR, f)),
          url: `/media/uploads/${f}`,
        });
        changed = true;
      }
    }
  } catch (e) {
    console.warn("[mediaRegistry] Failed to scan uploads:", e);
  }

  try {
    const outputFiles = await readdir(OUTPUT_DIR);
    for (const f of outputFiles) {
      const id = `out-${f}`;
      seen.add(id);
      if (!items.has(id)) {
        items.set(id, {
          id,
          filename: f,
          type: "output",
          label: f,
          createdAt: await fileCreatedAt(join(OUTPUT_DIR, f)),
          url: `/media/output/${f}`,
        });
        changed = true;
      }
    }
  } catch (e) {
    console.warn("[mediaRegistry] Failed to scan outputs:", e);
  }

  // Drop registry entries whose backing file is gone.
  for (const [id, item] of items) {
    if ((item.type === "upload" || item.type === "output") && !seen.has(id)) {
      items.delete(id);
      changed = true;
    }
  }

  if (changed) await saveSidecar();
}

export async function init(): Promise<void> {
  const saved = await loadSidecar();
  for (const [id, item] of Object.entries(saved)) {
    items.set(id, item);
  }
  await scanDisk();
}

export function getAll(): MediaItem[] {
  return Array.from(items.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function get(id: string): MediaItem | undefined {
  return items.get(id);
}

export async function register(
  item: Omit<MediaItem, "createdAt">
): Promise<MediaItem> {
  const full: MediaItem = { ...item, createdAt: Date.now() };
  items.set(full.id, full);
  await saveSidecar();
  return full;
}

export async function update(
  id: string,
  patch: Partial<Pick<MediaItem, "label" | "duration" | "inPoint" | "outPoint">>
): Promise<MediaItem | undefined> {
  const item = items.get(id);
  if (!item) return undefined;
  Object.assign(item, patch);
  await saveSidecar();
  return item;
}

export async function remove(id: string): Promise<boolean> {
  const deleted = items.delete(id);
  if (deleted) await saveSidecar();
  return deleted;
}
