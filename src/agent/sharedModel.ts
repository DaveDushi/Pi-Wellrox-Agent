import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { join } from "path";

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

let settingsManager: SettingsManager | null = null;

export function getSettingsManager(): SettingsManager {
  if (!settingsManager) {
    settingsManager = SettingsManager.create(process.cwd());
  }
  return settingsManager;
}

export async function readSettings(): Promise<PiSettings> {
  try {
    const file = Bun.file(SETTINGS_PATH);
    if (await file.exists()) {
      return { ...DEFAULT_SETTINGS, ...(await file.json()) };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export async function writeSettings(settings: PiSettings): Promise<void> {
  await Bun.write(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
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
  const file = Bun.file(SETTINGS_PATH);
  if (!(await file.exists())) {
    await writeSettings(DEFAULT_SETTINGS);
  }
}
