import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
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
  getOutputPath,
  getOutputFilename,
} from "../fileManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3141;
let mainWindow: BrowserWindow | null = null;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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

  // Process video — streaming via IPC events
  ipcMain.on("agent:process-video", async (event, data) => {
    const { selectedMedia, description } = data;
    const sender = event.sender;

    const clips: {
      letter: string;
      item: registry.MediaItem;
      inPoint?: number;
      outPoint?: number;
    }[] = [];

    for (let i = 0; i < selectedMedia.length; i++) {
      const sel = selectedMedia[i];
      const item = registry.get(sel.id);
      if (!item) {
        sender.send("agent:error", {
          message: `Media item ${sel.id} not found`,
        });
        return;
      }
      clips.push({
        letter: String.fromCharCode(65 + i),
        item,
        inPoint: sel.inPoint,
        outPoint: sel.outPoint,
      });
    }

    const jobId = generateJobId();
    const outputPath = resolve(getOutputPath(jobId));
    const outputFilename = getOutputFilename(jobId);

    const clipLines = clips.map((cl) => {
      const absPath =
        cl.item.type === "upload"
          ? resolve(getUploadPath(cl.item.filename))
          : resolve(join(OUTPUT_DIR, cl.item.filename));

      let range = "(full clip)";
      if (cl.inPoint != null && cl.outPoint != null) {
        range = `(use range ${formatTime(cl.inPoint)} to ${formatTime(cl.outPoint)} only)`;
      } else if (cl.inPoint != null) {
        range = `(start from ${formatTime(cl.inPoint)})`;
      } else if (cl.outPoint != null) {
        range = `(use up to ${formatTime(cl.outPoint)})`;
      }

      return `  [${cl.letter}] "${cl.item.label}" — ${absPath} ${range}`;
    });

    const prompt = [
      `The user has selected the following video file${clips.length > 1 ? "s" : ""} for this task:`,
      ``,
      ...clipLines,
      ``,
      `They want the following changes: "${description}"`,
      ``,
      `Save the output video to: ${outputPath}`,
      `The output MUST be MP4 format (H.264 video + AAC audio) for browser playback.`,
      `Use FFmpeg to process the video. If FFmpeg is not available, tell the user.`,
      ``,
      `When the output file has been successfully created and verified, output this exact line on its own:`,
      `OUTPUT_READY:${outputFilename}`,
    ].join("\n");

    const parentIds = clips.map((cl) => cl.item.id);
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
            const url = `/media/output/${match[1]}`;
            registry
              .register({
                id: jobId,
                filename: outputFilename,
                type: "output",
                label:
                  description.slice(0, 60) +
                  (description.length > 60 ? "..." : ""),
                parentIds,
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
