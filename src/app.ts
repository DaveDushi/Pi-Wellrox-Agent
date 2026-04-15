import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { unlink, access } from "fs/promises";
import { join } from "path";
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
import { getOutputPath, getOutputFilename } from "./fileManager.js";
import { resolve } from "path";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
    const { selectedMedia, description } = body;

    if (!selectedMedia?.length || !description?.trim()) {
      return c.json({ error: "selectedMedia and description are required" }, 400);
    }

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
        return c.json({ error: `Media item ${sel.id} not found` }, 404);
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

  // Serve media files (uploads + output) — reject path traversal
  app.use(
    "/media/*",
    async (c, next) => {
      const path = c.req.path;
      if (path.includes("..")) {
        return c.json({ error: "Invalid path" }, 400);
      }
      await next();
    },
    serveStatic({
      root: "./data",
      rewriteRequestPath: (path: string) => path.replace(/^\/media/, ""),
    })
  );

  // Static files (SPA) — after API routes
  app.use("/*", serveStatic({ root: "./public" }));

  return app;
}
