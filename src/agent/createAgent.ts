import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import { readdir } from "fs/promises";
import { join } from "path";
import { readSettings } from "./sharedModel.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { getAuthStorage, getModelRegistry } from "./startup.js";

let session: AgentSession | null = null;

async function discoverSkills(): Promise<Skill[]> {
  const skillsDir = join(process.cwd(), "skills");
  const skills: Skill[] = [];
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(skillsDir, entry.name);
      const skillFile = join(skillDir, "SKILL.md");
      const file = Bun.file(skillFile);
      if (await file.exists()) {
        skills.push({
          name: entry.name,
          description: `Skill: ${entry.name}`,
          filePath: skillFile,
          baseDir: skillDir,
          source: "custom",
        });
      }
    }
  } catch {}
  return skills;
}

export async function initAgent(): Promise<void> {
  const settings = await readSettings();
  const authStorage = getAuthStorage();
  const modelRegistry = getModelRegistry();
  const systemPrompt = buildSystemPrompt();
  const projectSkills = await discoverSkills();

  const modelId = settings.defaultModel;
  const model = modelId
    ? modelRegistry
        .getAvailable()
        .find((m: any) => m.id === modelId)
    : undefined;

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
    skillsOverride: (current) => ({
      skills: [...current.skills, ...projectSkills],
      diagnostics: current.diagnostics,
    }),
  });
  await loader.reload();

  const result = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel:
      (settings.defaultThinkingLevel as any) || "high",
  });

  session = result.session;
}

export async function handleChat(
  userMessage: string,
  onDelta: (text: string) => void,
  onDone: () => void,
  onError: (error: Error) => void
): Promise<void> {
  if (!session) {
    try {
      await initAgent();
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
  }

  let unsubscribe: (() => void) | null = null;

  try {
    unsubscribe = session!.subscribe((event: AgentSessionEvent) => {
      if (
        event.type === "message_update" &&
        "assistantMessageEvent" in event
      ) {
        const msgEvent = (event as any).assistantMessageEvent;
        if (msgEvent.type === "text_delta" && msgEvent.delta) {
          onDelta(msgEvent.delta);
        }
      }
    });

    await session!.prompt(userMessage);
    onDone();
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  } finally {
    if (unsubscribe) unsubscribe();
  }
}

export function resetSession(): void {
  if (session) {
    session.dispose();
  }
  session = null;
}
