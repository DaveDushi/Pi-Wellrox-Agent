const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  phase: "loading", // loading | auth | models | chat
  models: [],
  selectedModel: null,
  currentModel: null,
  messages: [],
  streaming: false,
};

// --- Startup Flow ---

async function checkStatus() {
  try {
    const res = await fetch("/api/startup/status");
    const data = await res.json();

    if (data.state === "needs_auth") {
      showAuthScreen();
    } else if (data.state === "needs_model") {
      state.currentModel = data.currentModel;
      await loadModels();
    } else if (data.state === "ready") {
      state.currentModel = data.currentModel;
      await loadModels();
    }
  } catch (err) {
    showStartupError("Failed to connect to server: " + err.message);
  }
}

function showAuthScreen() {
  state.phase = "auth";
  $("#startup-content").innerHTML = `
    <h1>Pi Wellrox Agent</h1>
    <p>Connect your OpenAI Codex account to get started.</p>
    <button class="btn btn-primary" id="auth-btn">Connect to OpenAI Codex</button>
    <div class="status-text" id="auth-status"></div>
  `;
  $("#auth-btn").addEventListener("click", startOAuth);
}

async function startOAuth() {
  const btn = $("#auth-btn");
  const status = $("#auth-status");
  btn.disabled = true;
  status.textContent = "Starting authentication...";

  try {
    const res = await fetch("/api/startup/auth", { method: "POST" });
    const data = await res.json();

    if (data.error) {
      status.textContent = "Error: " + data.error;
      btn.disabled = false;
      return;
    }

    window.open(data.url, "_blank");
    status.innerHTML = '<div class="spinner"></div>';
    status.insertAdjacentHTML("beforeend", "<br>Complete authentication in the opened tab...");

    pollOAuthStatus();
  } catch (err) {
    status.textContent = "Error: " + err.message;
    btn.disabled = false;
  }
}

async function pollOAuthStatus() {
  const poll = async () => {
    try {
      const res = await fetch("/api/startup/auth/status");
      const data = await res.json();

      if (data.complete) {
        await loadModels();
        return;
      }
    } catch {}
    setTimeout(poll, 2000);
  };
  poll();
}

async function loadModels() {
  state.phase = "models";
  $("#startup-content").innerHTML = `
    <h1>Select a Model</h1>
    <p>Choose which model to use for this session.</p>
    <div class="spinner"></div>
    <div class="status-text">Loading available models...</div>
  `;

  try {
    const res = await fetch("/api/startup/models");
    const data = await res.json();

    if (data.error) {
      showStartupError("Failed to load models: " + data.error);
      return;
    }

    state.models = data.models;
    showModelPicker();
  } catch (err) {
    showStartupError("Failed to load models: " + err.message);
  }
}

function showModelPicker() {
  const modelsHtml = state.models
    .map((m) => {
      const isCurrentModel = m.id === state.currentModel;
      return `
        <div class="model-card ${isCurrentModel ? "selected" : ""}" data-model-id="${m.id}">
          <div class="model-name">${escapeHtml(m.name)}${isCurrentModel ? " (previous)" : ""}</div>
          <div class="model-id">${escapeHtml(m.id)}</div>
        </div>
      `;
    })
    .join("");

  $("#startup-content").innerHTML = `
    <h1>Select a Model</h1>
    <p>Choose which model to use for this session.</p>
    <div class="model-grid">${modelsHtml}</div>
    <button class="btn btn-primary" id="confirm-model-btn" ${state.currentModel ? "" : "disabled"}>
      Launch Chat
    </button>
  `;

  state.selectedModel = state.currentModel || null;

  $$(".model-card").forEach((card) => {
    card.addEventListener("click", () => {
      $$(".model-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      state.selectedModel = card.dataset.modelId;
      $("#confirm-model-btn").disabled = false;
    });
  });

  $("#confirm-model-btn").addEventListener("click", confirmModel);
}

async function confirmModel() {
  if (!state.selectedModel) return;

  const btn = $("#confirm-model-btn");
  btn.disabled = true;
  btn.textContent = "Starting...";

  try {
    const res = await fetch("/api/startup/select-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: state.selectedModel }),
    });
    const data = await res.json();

    if (data.error) {
      showStartupError("Failed to select model: " + data.error);
      return;
    }

    state.currentModel = state.selectedModel;
    enterChat();
  } catch (err) {
    showStartupError("Failed to select model: " + err.message);
  }
}

function showStartupError(msg) {
  const existing = $("#startup-content .error-banner");
  if (existing) existing.remove();
  $("#startup-content").insertAdjacentHTML(
    "afterbegin",
    `<div class="error-banner">${escapeHtml(msg)}</div>`
  );
}

// --- Chat ---

function enterChat() {
  state.phase = "chat";
  state.messages = [];

  $("#startup-overlay").classList.add("hidden");
  $("#chat-container").classList.add("active");
  $(".model-badge").textContent = state.currentModel;
  $("#message-input").focus();
}

async function sendMessage() {
  const input = $("#message-input");
  const text = input.value.trim();
  if (!text || state.streaming) return;

  input.value = "";
  autoResizeTextarea(input);

  addMessage("user", text);
  state.streaming = true;
  updateSendButton();

  const assistantEl = addMessage("assistant", "");
  const contentEl = assistantEl.querySelector(".content");
  contentEl.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    if (!res.ok) {
      const err = await res.json();
      contentEl.textContent = "Error: " + (err.error || "Unknown error");
      state.streaming = false;
      updateSendButton();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let firstChunk = true;
    let currentEvent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const data = JSON.parse(jsonStr);

            if (currentEvent === "error" && data.message) {
              contentEl.textContent = "Error: " + data.message;
              continue;
            }

            if (currentEvent === "delta" && data.text) {
              if (firstChunk) {
                contentEl.textContent = "";
                firstChunk = false;
              }
              fullText += data.text;
              contentEl.textContent = fullText;
              scrollToBottom();
            }
          } catch {}
        }

        if (line === "") {
          currentEvent = "";
        }
      }
    }

    if (firstChunk) {
      contentEl.textContent = fullText || "(empty response)";
    }

    state.messages.push({ role: "assistant", content: fullText });
  } catch (err) {
    contentEl.textContent = "Error: " + err.message;
  }

  state.streaming = false;
  updateSendButton();
  $("#message-input").focus();
}

function addMessage(role, content) {
  if (role === "user") {
    state.messages.push({ role: "user", content });
  }

  const messages = $(".messages");
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `
    <div class="role-label">${role === "user" ? "You" : "Pi"}</div>
    <div class="content">${escapeHtml(content)}</div>
  `;
  messages.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  const messages = $(".messages");
  messages.scrollTop = messages.scrollHeight;
}

function updateSendButton() {
  $("#send-btn").disabled = state.streaming;
}

function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---

document.addEventListener("DOMContentLoaded", () => {
  const input = $("#message-input");

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  input.addEventListener("input", () => autoResizeTextarea(input));

  $("#send-btn").addEventListener("click", sendMessage);

  checkStatus();
});
