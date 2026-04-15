import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { readSettings, updateSettings } from "./sharedModel.js";

export type StartupState = "needs_auth" | "needs_model" | "ready";

let currentState: StartupState = "needs_model";
let authStorage: AuthStorage | null = null;
let modelRegistry: ModelRegistry | null = null;
let pendingOAuthUrl: string | null = null;
let oauthComplete = false;

export function getAuthStorage(): AuthStorage {
  if (!authStorage) {
    authStorage = AuthStorage.create();
  }
  return authStorage;
}

export function getModelRegistry(): ModelRegistry {
  if (!modelRegistry) {
    modelRegistry = ModelRegistry.create(getAuthStorage());
  }
  return modelRegistry;
}

export async function getStartupStatus(): Promise<{
  state: StartupState;
  currentModel?: string;
}> {
  const settings = await readSettings();

  if (currentState === "ready") {
    return { state: "ready", currentModel: settings.defaultModel };
  }

  const hasCredentials = getAuthStorage().hasAuth("openai-codex");

  if (!hasCredentials) {
    currentState = "needs_auth";
    return { state: "needs_auth" };
  }

  currentState = "needs_model";
  return { state: "needs_model", currentModel: settings.defaultModel };
}

export async function initiateOAuth(): Promise<{ url: string }> {
  oauthComplete = false;
  pendingOAuthUrl = null;

  const auth = getAuthStorage();

  const loginPromise = auth.login("openai-codex", {
    onAuth(info) {
      pendingOAuthUrl = info.url;
    },
    async onPrompt() {
      return "";
    },
    onProgress() {},
  });

  const start = Date.now();
  while (!pendingOAuthUrl && Date.now() - start < 10000) {
    await new Promise((r) => setTimeout(r, 100));
  }

  loginPromise
    .then(() => {
      oauthComplete = true;
    })
    .catch(() => {
      oauthComplete = false;
    });

  if (!pendingOAuthUrl) {
    throw new Error("OAuth URL not received from provider");
  }

  return { url: pendingOAuthUrl };
}

export function getOAuthStatus(): { complete: boolean } {
  return { complete: oauthComplete };
}

export async function fetchModels(): Promise<
  Array<{ id: string; name: string; provider: string }>
> {
  const registry = getModelRegistry();
  const models = registry.getAvailable();

  return models.map((m: any) => ({
    id: m.id,
    name: m.name || m.id,
    provider: m.provider || "openai-codex",
  }));
}

export async function selectModel(modelId: string): Promise<void> {
  await updateSettings({
    defaultProvider: "openai-codex",
    defaultModel: modelId,
    defaultThinkingLevel: "high",
  });
  currentState = "ready";
}

export function resetStartupState(): void {
  currentState = "needs_model";
  oauthComplete = false;
  pendingOAuthUrl = null;
}
