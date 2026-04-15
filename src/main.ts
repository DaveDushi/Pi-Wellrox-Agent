import { serve } from "@hono/node-server";
import { ensureSettingsFile } from "./agent/sharedModel.js";
import { resetStartupState } from "./agent/startup.js";
import { ensureDirectories } from "./fileManager.js";
import { init as initMediaRegistry } from "./mediaRegistry.js";
import { createApp } from "./app.js";
import { cleanupAllTempDirs } from "./tempManager.js";

export async function startServer(port: number): Promise<void> {
  await ensureSettingsFile();
  await ensureDirectories();
  await initMediaRegistry();
  resetStartupState();

  const app = createApp();

  const shutdown = async () => {
    await cleanupAllTempDirs();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`
  ╔═══════════════════════════════════╗
  ║       Pi Wellrox Agent v0.1       ║
  ║                                   ║
  ║  http://localhost:${port}            ║
  ╚═══════════════════════════════════╝
  `);

  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
}
