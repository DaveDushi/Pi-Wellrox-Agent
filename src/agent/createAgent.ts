import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import { readdir, access, mkdir } from "fs/promises";
import { join } from "path";
import { readSettings } from "./sharedModel.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { getAuthStorage, getModelRegistry } from "./startup.js";
import { getPiDir, getSkillsDir, getUserDataDir } from "../paths.js";

let session: AgentSession | null = null;
let sessionPromise: Promise<void> | null = null;
let promptBusy = false;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverSkills(): Promise<Skill[]> {
  const skillsDir = getSkillsDir();
  const skills: Skill[] = [];
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(skillsDir, entry.name);
      const skillFile = join(skillDir, "SKILL.md");
      if (await fileExists(skillFile)) {
        skills.push({
          name: entry.name,
          description: `Skill: ${entry.name}`,
          filePath: skillFile,
          baseDir: skillDir,
        } as Skill);
      }
    }
  } catch (e) {
    console.warn("[agent] Failed to discover skills:", e);
  }
  return skills;
}

async function doInitAgent(): Promise<void> {
  const settings = await readSettings();
  const authStorage = getAuthStorage();
  const modelRegistry = getModelRegistry();
  const projectSkills = await discoverSkills();

  const modelId = settings.defaultModel;
  const model = modelId
    ? modelRegistry
        .getAvailable()
        .find((m: any) => m.id === modelId)
    : undefined;

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => buildSystemPrompt(),
    skillsOverride: (current) => ({
      skills: [...current.skills, ...projectSkills],
      diagnostics: current.diagnostics,
    }),
  });
  await loader.reload();

  const sessionsDir = join(getPiDir(), "sessions");
  await mkdir(sessionsDir, { recursive: true });

  const result = await createAgentSession({
    sessionManager: SessionManager.create(getUserDataDir(), sessionsDir),
    resourceLoader: loader,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel:
      (settings.defaultThinkingLevel as any) || "high",
  });

  session = result.session;
}

async function ensureSession(): Promise<void> {
  if (session) return;
  if (!sessionPromise) {
    sessionPromise = doInitAgent().finally(() => {
      sessionPromise = null;
    });
  }
  await sessionPromise;
}

export type AgentEvent =
  | { kind: "thinking"; text: string }
  | { kind: "tool_start"; tool: string }
  | { kind: "tool_update"; text: string }
  | {
      kind: "tool_end";
      tool: string;
      success: boolean;
      errorDetail?: string;
    }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | { kind: "compaction_start" }
  | { kind: "compaction_end" }
  | { kind: "retry_start" }
  | { kind: "retry_end" };

function extractToolErrorDetail(result: unknown): string | undefined {
  if (!result) return undefined;
  if (result instanceof Error) {
    return result.message;
  }
  if (typeof result === "string") {
    return result;
  }
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.message === "string") return r.message as string;
    if (Array.isArray(r.content)) {
      const parts = r.content
        .map((c: any) =>
          c && typeof c === "object" && typeof c.text === "string" ? c.text : ""
        )
        .filter(Boolean);
      if (parts.length > 0) return parts.join("\n");
    }
    try {
      return JSON.stringify(result);
    } catch {
      return undefined;
    }
  }
  return String(result);
}

function tailLines(text: string, maxChars = 600): string {
  if (text.length <= maxChars) return text;
  return "…" + text.slice(text.length - maxChars);
}

export async function handleChat(
  userMessage: string,
  onDelta: (text: string) => void,
  onDone: () => void,
  onError: (error: Error) => void,
  onEvent?: (event: AgentEvent) => void
): Promise<void> {
  if (promptBusy) {
    onError(new Error("Agent is already processing a request. Please wait."));
    return;
  }

  try {
    await ensureSession();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  promptBusy = true;
  let unsubscribe: (() => void) | null = null;

  try {
    unsubscribe = session!.subscribe((event: AgentSessionEvent) => {
      const ev = event as any;

      switch (event.type) {
        case "message_update": {
          if ("assistantMessageEvent" in event) {
            const msgEvent = ev.assistantMessageEvent;
            if (msgEvent.type === "text_delta" && msgEvent.delta) {
              onDelta(msgEvent.delta);
            }
            if (msgEvent.type === "thinking_delta" && msgEvent.delta) {
              onEvent?.({ kind: "thinking", text: msgEvent.delta });
            }
          }
          break;
        }
        case "tool_execution_start":
          onEvent?.({ kind: "tool_start", tool: ev.toolName ?? "unknown" });
          break;
        case "tool_execution_update":
          if (ev.partialResult) {
            onEvent?.({ kind: "tool_update", text: String(ev.partialResult) });
          }
          break;
        case "tool_execution_end": {
          const isError = !!ev.isError;
          let errorDetail: string | undefined;
          if (isError) {
            const raw = extractToolErrorDetail(ev.result);
            if (raw) errorDetail = tailLines(raw);
          }
          onEvent?.({
            kind: "tool_end",
            tool: ev.toolName ?? "unknown",
            success: !isError,
            errorDetail,
          });
          break;
        }
        case "turn_start":
          onEvent?.({ kind: "turn_start" });
          break;
        case "turn_end":
          onEvent?.({ kind: "turn_end" });
          break;
        case "compaction_start":
          onEvent?.({ kind: "compaction_start" });
          break;
        case "compaction_end":
          onEvent?.({ kind: "compaction_end" });
          break;
        case "auto_retry_start":
          onEvent?.({ kind: "retry_start" });
          break;
        case "auto_retry_end":
          onEvent?.({ kind: "retry_end" });
          break;
      }
    });

    await session!.prompt(userMessage);
    onDone();
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  } finally {
    promptBusy = false;
    if (unsubscribe) unsubscribe();
  }
}

export function resetSession(): void {
  if (session) {
    session.dispose();
  }
  session = null;
  sessionPromise = null;
  promptBusy = false;
}
