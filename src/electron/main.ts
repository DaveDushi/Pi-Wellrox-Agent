import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { access, unlink } from "fs/promises";
import { startServer } from "../main.js";
import {
  handleChat,
  resetSession,
  type AgentEvent,
} from "../agent/createAgent.js";
import {
  getStartupStatus,
  initiateOAuth,
  getOAuthStatus,
  fetchModels,
  selectModel,
} from "../agent/startup.js";
import * as registry from "../mediaRegistry.js";
import {
  OUTPUT_DIR,
  generateJobId,
  getUploadPath,
} from "../fileManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3141;
let mainWindow: BrowserWindow | null = null;

// --- IPC Handlers ---

function registerIpcHandlers() {
  // Startup
  ipcMain.handle("startup:status", () => getStartupStatus());

  ipcMain.handle("startup:auth", async () => {
    try {
      return await initiateOAuth();
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "OAuth failed",
      };
    }
  });

  ipcMain.handle("startup:auth-status", () => getOAuthStatus());

  ipcMain.handle("startup:models", async () => {
    try {
      const models = await fetchModels();
      return { models };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to fetch models",
      };
    }
  });

  ipcMain.handle(
    "startup:select-model",
    async (_event, modelId: string) => {
      if (!modelId) return { error: "modelId is required" };
      await selectModel(modelId);
      resetSession();
      return { status: "ready" };
    }
  );

  // Media CRUD
  ipcMain.handle("media:list", () => ({ items: registry.getAll() }));

  ipcMain.handle(
    "media:update",
    async (_event, id: string, data: any) => {
      const updated = await registry.update(id, data);
      if (!updated) return { error: "Not found" };
      return updated;
    }
  );

  ipcMain.handle("media:delete", async (_event, id: string) => {
    const item = registry.get(id);
    if (!item) return { error: "Not found" };

    try {
      const filePath =
        item.type === "upload"
          ? getUploadPath(item.filename)
          : join(OUTPUT_DIR, item.filename);
      try {
        await access(filePath);
        await unlink(filePath);
      } catch {}
    } catch {}

    await registry.remove(id);
    return { ok: true };
  });

  // Agent
  ipcMain.handle("agent:reset", () => {
    resetSession();
    return { ok: true };
  });

  // Agent chat — streaming via IPC events
  ipcMain.on("agent:chat", async (event, data) => {
    const { description } = data;
    const sender = event.sender;

    if (!description?.trim()) {
      sender.send("agent:error", { message: "description is required" });
      return;
    }

    const prompt = description.trim();
    let accumulatedText = "";
    let outputDetected = false;

    await handleChat(
      prompt,
      (text) => {
        sender.send("agent:delta", { text });
        accumulatedText += text;

        if (!outputDetected && accumulatedText.includes("OUTPUT_READY:")) {
          outputDetected = true;
          const match = accumulatedText.match(/OUTPUT_READY:(\S+)/);
          if (match) {
            const outputFilename = match[1];
            const jobId = generateJobId();
            const url = `/media/output/${outputFilename}`;
            registry
              .register({
                id: jobId,
                filename: outputFilename,
                type: "output",
                label:
                  description.slice(0, 60) +
                  (description.length > 60 ? "..." : ""),
                url,
                description,
              })
              .then(() => {
                sender.send("agent:output-ready", { url, id: jobId });
              });
          }
        }
      },
      () => sender.send("agent:done", {}),
      (error) => sender.send("agent:error", { message: error.message }),
      (agentEvent: AgentEvent) => sender.send("agent:event", agentEvent)
    );
  });
}

// --- Window ---

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  registerIpcHandlers();
  await startServer(PORT);
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
