import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import {
  getStartupStatus,
  initiateOAuth,
  getOAuthStatus,
  fetchModels,
  selectModel,
} from "./agent/startup.js";
import { handleChat, resetSession } from "./agent/createAgent.js";

export function createApp(): Hono {
  const app = new Hono();

  // Startup status
  app.get("/api/startup/status", async (c) => {
    const status = await getStartupStatus();
    return c.json(status);
  });

  // Initiate OAuth
  app.post("/api/startup/auth", async (c) => {
    try {
      const result = await initiateOAuth();
      return c.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "OAuth initiation failed";
      return c.json({ error: message }, 500);
    }
  });

  // Poll OAuth status
  app.get("/api/startup/auth/status", async (c) => {
    return c.json(getOAuthStatus());
  });

  // List available models
  app.get("/api/startup/models", async (c) => {
    try {
      const models = await fetchModels();
      return c.json({ models });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to fetch models";
      return c.json({ error: message }, 500);
    }
  });

  // Select model
  app.post("/api/startup/select-model", async (c) => {
    const body = await c.req.json<{ modelId: string }>();
    if (!body.modelId) {
      return c.json({ error: "modelId is required" }, 400);
    }
    await selectModel(body.modelId);
    resetSession();
    return c.json({ status: "ready" });
  });

  // Chat endpoint with SSE streaming
  app.post("/api/chat", async (c) => {
    const body = await c.req.json<{ message: string }>();
    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }

    return streamSSE(c, async (stream) => {
      await handleChat(
        body.message,
        (text) => {
          stream.writeSSE({ event: "delta", data: JSON.stringify({ text }) });
        },
        () => {
          stream.writeSSE({ event: "done", data: "{}" });
        },
        (error) => {
          stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: error.message }),
          });
        }
      );
    });
  });

  // Static files — after API routes so they don't shadow them
  app.use("/*", serveStatic({ root: "./public" }));

  return app;
}
