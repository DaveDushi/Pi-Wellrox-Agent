import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { access, unlink } from "fs/promises";
import {
  ensureFfmpegInstalled,
  injectFfmpegIntoPath,
  verifyFfmpeg,
} from "./ffmpeg.js";
import {
  ensurePortableShellInstalled,
  injectShellPathEntries,
  writeShellPathSetting,
} from "./portableShell.js";
import { startServer } from "../main.js";
import { configurePaths } from "../paths.js";
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
import { OUTPUT_DIR, getUploadPath } from "../fileManager.js";
import { cleanupAllTempDirs } from "../tempManager.js";
import { initUpdater } from "./updater.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let serverPort = 0;

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
  ipcMain.handle("media:list", async () => {
    await registry.scanDisk();
    return { items: registry.getAll() };
  });

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

    await handleChat(
      prompt,
      (text) => sender.send("agent:delta", { text }),
      () => sender.send("agent:done", {}),
      (error) => sender.send("agent:error", { message: error.message }),
      (agentEvent: AgentEvent) => sender.send("agent:event", agentEvent)
    );
  });
}

// --- Window ---

async function createWindow(port: number): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- App lifecycle ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const localData =
      process.platform === "win32" && process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, app.getName())
        : app.getPath("userData");

    configurePaths({
      userData: app.getPath("userData"),
      localData,
      appRoot: app.getAppPath(),
      resources: app.isPackaged ? process.resourcesPath : app.getAppPath(),
    });

    await ensureFfmpegInstalled();
    injectFfmpegIntoPath();
    const ffCheck = verifyFfmpeg();
    if (!ffCheck.ok)
      console.error("[startup] FFmpeg check failed:", ffCheck.error);

    const bashPath = await ensurePortableShellInstalled();
    if (bashPath) {
      await writeShellPathSetting(bashPath);
      injectShellPathEntries();
    }

    registerIpcHandlers();

    try {
      const started = await startServer(0);
      serverPort = started.port;
      await createWindow(serverPort);
      initUpdater();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      dialog.showErrorBox(
        "Pi Wellrox Agent failed to start",
        `The local server could not start.\n\n${message}`
      );
      app.exit(1);
      return;
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
        createWindow(serverPort);
      }
    });
  });
}

app.on("before-quit", async (e) => {
  e.preventDefault();
  await cleanupAllTempDirs();
  app.exit(0);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
