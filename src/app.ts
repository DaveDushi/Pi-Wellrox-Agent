import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createReadStream, createWriteStream, statSync } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { unlink, access } from "fs/promises";
import { join } from "path";
import { getDataDir, getPublicDir } from "./paths.js";
import * as registry from "./mediaRegistry.js";
import {
  MAX_FILE_SIZE,
  generateJobId,
  getUploadPath,
  OUTPUT_DIR,
} from "./fileManager.js";
import {
  getStartupStatus,
  initiateOAuth,
  getOAuthStatus,
  fetchModels,
  selectModel,
} from "./agent/startup.js";
import { handleChat, resetSession, type AgentEvent } from "./agent/createAgent.js";
import { getUpdateState, checkForUpdates, quitAndInstall } from "./electron/updater.js";

export function createApp(): Hono {
  const app = new Hono();

  // --- Startup API ---

  app.get("/api/status", async (c) => {
    try {
      return c.json(await getStartupStatus());
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
    }
  });

  app.post("/api/auth", async (c) => {
    try {
      return c.json(await initiateOAuth());
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "OAuth failed" }, 500);
    }
  });

  app.get("/api/auth/status", (c) => {
    return c.json(getOAuthStatus());
  });

  app.get("/api/models", async (c) => {
    try {
      const models = await fetchModels();
      return c.json({ models });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Failed to fetch models" }, 500);
    }
  });

  app.post("/api/select-model", async (c) => {
    try {
      const body = await c.req.json();
      const modelId = body.modelId;
      if (!modelId) return c.json({ error: "modelId is required" }, 400);
      await selectModel(modelId);
      resetSession();
      return c.json({ status: "ready" });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Failed to select model" }, 500);
    }
  });

  // --- Update API ---

  app.get("/api/update/status", (c) => {
    return c.json(getUpdateState());
  });

  app.post("/api/update/check", async (c) => {
    return c.json(await checkForUpdates());
  });

  app.post("/api/update/install", (c) => {
    quitAndInstall();
    return c.json({ ok: true });
  });

  // --- Media API ---

  app.get("/api/media", (c) => {
    return c.json({ items: registry.getAll() });
  });

  app.patch("/api/media/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const patch = await c.req.json();
      const updated = await registry.update(id, patch);
      if (!updated) return c.json({ error: "Not found" }, 404);
      return c.json(updated);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Update failed" }, 500);
    }
  });

  app.delete("/api/media/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const item = registry.get(id);
      if (!item) return c.json({ error: "Not found" }, 404);

      const filePath =
        item.type === "upload"
          ? getUploadPath(item.filename)
          : join(OUTPUT_DIR, item.filename);
      try {
        await access(filePath);
        await unlink(filePath);
      } catch {}

      await registry.remove(id);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Delete failed" }, 500);
    }
  });

  // --- File upload (large files stay as HTTP) ---

  app.post("/api/upload", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body["file"];

      if (!file || typeof file === "string") {
        return c.json({ error: "No file provided" }, 400);
      }

      if (file.size > MAX_FILE_SIZE) {
        return c.json({ error: "File too large (max 500MB)" }, 413);
      }

      if (!file.type.startsWith("video/")) {
        return c.json({ error: "Only video files are accepted" }, 400);
      }

      const jobId = generateJobId();
      const ext = (file.name?.split(".").pop() || "mp4").replace(/[^a-zA-Z0-9]/g, "");
      const safeName = `${jobId}.${ext}`;
      const savePath = getUploadPath(safeName);

      const webStream = file.stream();
      const nodeStream = Readable.fromWeb(webStream as any);
      await pipeline(nodeStream, createWriteStream(savePath));

      const item = await registry.register({
        id: jobId,
        filename: safeName,
        type: "upload",
        label: file.name || safeName,
        originalName: file.name,
        url: `/media/uploads/${safeName}`,
      });

      return c.json(item);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Upload failed";
      return c.json({ error: message }, 500);
    }
  });

  // --- Agent chat (SSE for browser mode) ---

  app.post("/api/chat", async (c) => {
    const body = await c.req.json();
    const { description } = body;

    if (!description?.trim()) {
      return c.json({ error: "description is required" }, 400);
    }

    const prompt = description.trim();

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event: string, data: any) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          let accumulatedText = "";
          let outputDetected = false;

          handleChat(
            prompt,
            (text) => {
              send("delta", { text });
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
                      send("output-ready", { url, id: jobId });
                    });
                }
              }
            },
            () => {
              send("done", {});
              controller.close();
            },
            (error) => {
              send("error", { message: error.message });
              controller.close();
            },
            (agentEvent: AgentEvent) => {
              send("event", agentEvent);
            }
          );
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }
    );
  });

  // --- Agent reset ---

  app.post("/api/agent/reset", (c) => {
    resetSession();
    return c.json({ ok: true });
  });

  // Serve media files (uploads + output) — reject path traversal.
  // Use a custom handler so the data dir is read lazily each request
  // (it lives under userData in the packaged app, not cwd).
  app.get("/media/*", async (c) => {
    const reqPath = c.req.path;
    if (reqPath.includes("..")) {
      return c.json({ error: "Invalid path" }, 400);
    }
    const rel = reqPath.replace(/^\/media\//, "");
    const abs = join(getDataDir(), rel);
    try {
      const stats = statSync(abs);
      if (!stats.isFile()) return c.json({ error: "Not found" }, 404);
      const stream = createReadStream(abs);
      return c.body(Readable.toWeb(stream) as any, 200, {
        "Content-Length": stats.size.toString(),
      });
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
  });

  // Static files (SPA) — after API routes. Root resolved at request time
  // via a closure so packaged app reads from asar instead of cwd.
  app.use("/*", serveStatic({ root: getPublicDir() }));

  return app;
}
