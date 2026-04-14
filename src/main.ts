import { ensureSettingsFile } from "./agent/sharedModel.js";
import { resetStartupState } from "./agent/startup.js";
import { createApp } from "./app.js";

const PORT = 3141;

async function main() {
  await ensureSettingsFile();
  resetStartupState();

  const app = createApp();

  console.log(`
  ╔═══════════════════════════════════╗
  ║       Pi Wellrox Agent v0.1       ║
  ║                                   ║
  ║  http://localhost:${PORT}            ║
  ╚═══════════════════════════════════╝
  `);

  Bun.serve({
    port: PORT,
    fetch: app.fetch,
    idleTimeout: 255,
  });
}

main();
