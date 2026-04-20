export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; percent: number; version: string }
  | { status: "ready"; version: string }
  | { status: "none"; version: string }
  | { status: "error"; message: string };

let state: UpdateState = { status: "idle" };
let autoUpdater: any = null;
let electronApp: any = null;

const inElectron = !!process.versions.electron;

async function loadElectronModules(): Promise<boolean> {
  if (!inElectron) return false;
  if (autoUpdater && electronApp) return true;
  try {
    const electron = await import("electron");
    electronApp = electron.app;
    const updater = await import("electron-updater");
    autoUpdater = (updater as any).default?.autoUpdater || (updater as any).autoUpdater;
    return !!autoUpdater && !!electronApp;
  } catch {
    return false;
  }
}

export function getUpdateState(): UpdateState {
  return state;
}

export async function initUpdater(): Promise<void> {
  const ok = await loadElectronModules();
  if (!ok || !electronApp.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    state = { status: "checking" };
  });

  autoUpdater.on("update-available", (info: any) => {
    state = { status: "available", version: info.version };
  });

  autoUpdater.on("update-not-available", (info: any) => {
    state = { status: "none", version: info.version };
  });

  autoUpdater.on("download-progress", (progress: any) => {
    const version =
      state.status === "downloading" || state.status === "available"
        ? (state as { version?: string }).version || ""
        : "";
    state = {
      status: "downloading",
      percent: Math.round(progress.percent),
      version,
    };
  });

  autoUpdater.on("update-downloaded", (info: any) => {
    state = { status: "ready", version: info.version };
  });

  autoUpdater.on("error", (err: Error) => {
    state = { status: "error", message: err?.message || "Update error" };
  });

  autoUpdater.checkForUpdates().catch((err: Error) => {
    state = {
      status: "error",
      message: err instanceof Error ? err.message : "Update check failed",
    };
  });
}

export async function checkForUpdates(): Promise<UpdateState> {
  const ok = await loadElectronModules();
  if (!ok || !electronApp.isPackaged) {
    return { status: "none", version: electronApp?.getVersion?.() || "" };
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    state = {
      status: "error",
      message: err instanceof Error ? err.message : "Update check failed",
    };
  }
  return state;
}

export function quitAndInstall(): void {
  if (state.status !== "ready" || !autoUpdater) return;
  autoUpdater.quitAndInstall();
}
