import { serve, type ServerType } from "@hono/node-server";
import { ensureSettingsFile } from "./agent/sharedModel.js";
import { resetStartupState } from "./agent/startup.js";
import { ensureDirectories } from "./fileManager.js";
import { init as initMediaRegistry } from "./mediaRegistry.js";
import { createApp } from "./app.js";
import { cleanupAllTempDirs } from "./tempManager.js";

export async function startServer(
  port: number
): Promise<{ server: ServerType; port: number }> {
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

  return new Promise((resolve, reject) => {
    let settled = false;
    const server = serve(
      { fetch: app.fetch, port, hostname: "127.0.0.1" },
      (info) => {
        settled = true;
        console.log(
          `Pi Wellrox Agent listening on http://127.0.0.1:${info.port}`
        );
        resolve({ server, port: info.port });
      }
    );
    server.on("error", (err) => {
      if (settled) {
        console.error("[server] runtime error:", err);
        return;
      }
      settled = true;
      reject(err);
    });
  });
}
