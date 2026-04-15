import { join, dirname } from "path";
import { readFile, writeFile, access, mkdir } from "fs/promises";

const PI_DIR = join(process.cwd(), ".pi");
const SETTINGS_PATH = join(PI_DIR, "settings.json");

export interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  [key: string]: unknown;
}

const DEFAULT_SETTINGS: PiSettings = {
  defaultProvider: "openai-codex",
  defaultThinkingLevel: "high",
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readSettings(): Promise<PiSettings> {
  try {
    if (await fileExists(SETTINGS_PATH)) {
      const raw = await readFile(SETTINGS_PATH, "utf-8");
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn("[settings] Failed to read settings:", e);
  }
  return { ...DEFAULT_SETTINGS };
}

export async function writeSettings(settings: PiSettings): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

export async function updateSettings(
  partial: Partial<PiSettings>
): Promise<PiSettings> {
  const current = await readSettings();
  const merged = { ...current, ...partial };
  await writeSettings(merged);
  return merged;
}

export async function ensureSettingsFile(): Promise<void> {
  if (!(await fileExists(SETTINGS_PATH))) {
    await writeSettings(DEFAULT_SETTINGS);
  }
}
