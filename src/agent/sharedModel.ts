import { join, dirname } from "path";
import { readFile, writeFile, access, mkdir } from "fs/promises";
import { getPiDir } from "../paths.js";

function settingsPath(): string {
  return join(getPiDir(), "settings.json");
}

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
    if (await fileExists(settingsPath())) {
      const raw = await readFile(settingsPath(), "utf-8");
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn("[settings] Failed to read settings:", e);
  }
  return { ...DEFAULT_SETTINGS };
}

export async function writeSettings(settings: PiSettings): Promise<void> {
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
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
  if (!(await fileExists(settingsPath()))) {
    await writeSettings(DEFAULT_SETTINGS);
  }
}
