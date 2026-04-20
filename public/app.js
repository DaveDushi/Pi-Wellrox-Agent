const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  phase: "loading",
  models: [],
  selectedModel: null,
  currentModel: null,
  mediaItems: [],
  attachedIds: [],
  previewId: null,
  processing: false,
  latestOutputId: null,
  thumbnailCache: {},
  durations: {},
  chatMessages: [],
  chatStreaming: false,
};

// =====================
// API Abstraction (Electron IPC vs HTTP)
// =====================

const piApi = {
  startup: {
    getStatus: () => fetch("/api/status").then((r) => r.json()),
    initiateAuth: () => fetch("/api/auth", { method: "POST" }).then((r) => r.json()),
    getAuthStatus: () => fetch("/api/auth/status").then((r) => r.json()),
    getModels: () => fetch("/api/models").then((r) => r.json()),
    selectModel: (id) =>
      fetch("/api/select-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: id }),
      }).then((r) => r.json()),
  },
  media: {
    list: () => fetch("/api/media").then((r) => r.json()),
    update: (id, data) =>
      fetch(`/api/media/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    remove: (id) => fetch(`/api/media/${id}`, { method: "DELETE" }).then((r) => r.json()),
  },
  agent: {
    processVideo: null,
    reset: () => fetch("/api/agent/reset", { method: "POST" }).then((r) => r.json()),
  },
  _sseListeners: {},
  on(channel, cb) {
    if (!this._sseListeners[channel]) this._sseListeners[channel] = [];
    this._sseListeners[channel].push(cb);
  },
  removeAllListeners(channel) {
    this._sseListeners[channel] = [];
  },
  _emit(channel, data) {
    (this._sseListeners[channel] || []).forEach((cb) => cb(data));
  },
};

// =====================
// Startup Flow
// =====================

async function checkStatus() {
  try {
    const data = await piApi.startup.getStatus();
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
    showStartupError("Failed to connect: " + err.message);
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
    const data = await piApi.startup.initiateAuth();
    if (data.error) {
      status.textContent = "Error: " + data.error;
      btn.disabled = false;
      return;
    }
    window.open(data.url, "_blank");
    status.innerHTML = '<div class="spinner"><span></span></div>';
    status.insertAdjacentHTML("beforeend", "<br>Complete authentication in the opened tab...");
    pollOAuthStatus();
  } catch (err) {
    status.textContent = "Error: " + err.message;
    btn.disabled = false;
  }
}

let oauthPollCount = 0;
const MAX_OAUTH_POLLS = 150;

async function pollOAuthStatus() {
  const poll = async () => {
    try {
      const data = await piApi.startup.getAuthStatus();
      if (data.complete) {
        oauthPollCount = 0;
        await loadModels();
        return;
      }
    } catch (e) {
      console.warn("[auth] Poll error:", e);
    }
    oauthPollCount++;
    if (oauthPollCount >= MAX_OAUTH_POLLS) {
      oauthPollCount = 0;
      showStartupError("Authentication timed out. Please try again.");
      const btn = $("#auth-btn");
      if (btn) btn.disabled = false;
      return;
    }
    setTimeout(poll, 2000);
  };
  poll();
}

async function loadModels() {
  state.phase = "models";
  $("#startup-content").innerHTML = `
    <h1>Select a Model</h1>
    <p>Choose which model to use for this session.</p>
    <div class="spinner"><span></span></div>
    <div class="status-text">Loading available models...</div>
  `;
  try {
    const data = await piApi.startup.getModels();
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
        <div class="model-card ${isCurrentModel ? "selected" : ""}" data-model-id="${escapeAttr(m.id)}">
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
      Launch Editor
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
    const data = await piApi.startup.selectModel(state.selectedModel);
    if (data.error) {
      showStartupError("Failed to select model: " + data.error);
      return;
    }
    state.currentModel = state.selectedModel;
    enterEditor();
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

// =====================
// Video Editor
// =====================

function enterEditor() {
  state.phase = "editor";
  $("#startup-overlay").classList.add("hidden");
  $("#editor-container").classList.add("active");
  $(".model-badge").textContent = state.currentModel;

  const chatInput = $("#chat-input");
  chatInput.addEventListener("input", () => {
    autoGrowTextarea(chatInput);
    updateSendButton();
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !$("#send-btn").disabled
        && !$("#mention-dropdown").classList.contains("visible")) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  $("#send-btn").addEventListener("click", () => {
    if (state.chatStreaming) {
      stopStreaming();
    } else {
      sendChatMessage();
    }
  });

  setupMediaBin();
  setupPreviewPanel();
  setupResizeHandles();
  fetchMediaLibrary();
}

// =====================
// Media Bin
// =====================

function setupMediaBin() {
  const bin = $("#media-bin");
  const dropZone = $("#media-drop-zone");
  const fileInput = $("#file-input");

  bin.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  bin.addEventListener("dragleave", (e) => {
    if (!bin.contains(e.relatedTarget)) {
      dropZone.classList.remove("dragover");
    }
  });

  bin.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("video/")
    );
    for (const file of files) uploadFile(file);
  });

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files);
    for (const file of files) {
      if (file.type.startsWith("video/") && file.size <= 500 * 1024 * 1024) {
        uploadFile(file);
      }
    }
    fileInput.value = "";
  });
}

async function fetchMediaLibrary() {
  const grid = $("#media-grid-uploads");
  if (grid && state.mediaItems.length === 0) {
    grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
  }
  try {
    const data = await piApi.media.list();
    state.mediaItems = (data.items || []).map((item) => {
      if (item.duration && item.duration > 0) {
        if (item.inPoint != null && item.inPoint >= item.duration) item.inPoint = undefined;
        if (item.outPoint != null && item.outPoint > item.duration) item.outPoint = undefined;
      }
      return item;
    });
    renderMediaBin();
  } catch (e) {
    console.warn("[media] Failed to fetch library:", e);
  }
}

function renderMediaBin() {
  const uploadsGrid = $("#media-grid-uploads");
  const outputsGrid = $("#media-grid-outputs");
  const dropZone = $("#media-drop-zone");

  uploadsGrid.querySelectorAll(".skeleton-card").forEach((el) => el.remove());

  if (state.mediaItems.length === 0) {
    uploadsGrid.innerHTML = "";
    outputsGrid.innerHTML = "";
    dropZone.style.display = "flex";
    updateChatInputState();
    return;
  }

  dropZone.style.display = "none";

  const allGrids = [uploadsGrid, outputsGrid];
  const existingCards = new Map();
  allGrids.forEach((g) =>
    g.querySelectorAll(".media-card").forEach((card) => {
      existingCards.set(card.dataset.id, card);
    })
  );

  const currentIds = new Set(state.mediaItems.map((item) => item.id));

  existingCards.forEach((card, id) => {
    if (!currentIds.has(id)) card.remove();
  });

  state.mediaItems.forEach((item) => {
    const targetGrid = item.type === "upload" ? uploadsGrid : outputsGrid;
    const attIdx = state.attachedIds.indexOf(item.id);
    const isAttached = attIdx !== -1;
    const letter = isAttached ? String.fromCharCode(65 + attIdx) : "";
    const isPreviewing = state.previewId === item.id;

    let card = existingCards.get(item.id);

    if (!card) {
      card = createMediaCard(item);
      targetGrid.appendChild(card);
    } else if (card.parentElement !== targetGrid) {
      targetGrid.appendChild(card);
    }

    card.classList.toggle("selected", isAttached);
    card.classList.toggle("previewing", isPreviewing);

    const letterEl = card.querySelector(".media-letter");
    if (letter) {
      if (!letterEl) {
        const el = document.createElement("div");
        el.className = "media-letter";
        el.textContent = letter;
        card.querySelector(".media-thumb").appendChild(el);
      } else {
        letterEl.textContent = letter;
      }
    } else if (letterEl) {
      letterEl.remove();
    }

    const duration = item.duration || state.durations[item.id];
    const durEl = card.querySelector(".media-duration");
    if (duration && durEl) {
      durEl.textContent = formatTime(duration);
    }
  });

  updateChatInputState();
  renderAttachmentBar();
}

function createMediaCard(item) {
  const card = document.createElement("div");
  card.className = "media-card";
  card.dataset.id = item.id;
  card.title = item.label;

  const duration = item.duration || state.durations[item.id];
  const durationStr = duration ? formatTime(duration) : "";
  const typeBadge = item.type === "upload" ? "Source" : "Edit";
  const lineage = item.parentIds?.length
    ? "from " +
      item.parentIds
        .map((pid) => {
          const parent = state.mediaItems.find((m) => m.id === pid);
          return parent ? parent.label.slice(0, 12) : "?";
        })
        .join(" + ")
    : "";

  card.innerHTML = `
    <button class="attach-btn" title="Attach to chat">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6h-1.5v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S6.5 2.79 6.5 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6H16.5z"/></svg>
    </button>
    <div class="media-thumb" data-url="${escapeAttr(item.url)}">
      <canvas width="160" height="90"></canvas>
      ${durationStr ? `<div class="media-duration">${durationStr}</div>` : '<div class="media-duration"></div>'}
      <div class="media-type-badge badge-${item.type === "upload" ? "upload" : "output"}">${typeBadge}</div>
    </div>
    <div class="media-info">
      <div class="media-label">${escapeHtml(item.label)}</div>
      ${lineage ? `<div class="media-lineage">${escapeHtml(lineage)}</div>` : ""}
    </div>
  `;

  const thumb = card.querySelector(".media-thumb");
  const canvas = thumb.querySelector("canvas");
  const url = item.url;

  if (state.thumbnailCache[item.id]) {
    drawCachedThumb(canvas, state.thumbnailCache[item.id]);
  } else {
    generateThumbnail(url, item.id, canvas);
  }

  setupHoverScrub(thumb, url, canvas, item.id);

  card.querySelector(".attach-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAttachment(item.id);
  });

  thumb.addEventListener("click", (e) => {
    e.stopPropagation();
    previewClip(item.id);
  });

  card.querySelector(".media-info").addEventListener("click", () => {
    previewClip(item.id);
  });

  return card;
}

function generateThumbnail(videoUrl, id, canvas) {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "metadata";
  video.src = videoUrl;

  video.addEventListener("loadedmetadata", () => {
    if (!state.durations[id] && video.duration && isFinite(video.duration)) {
      state.durations[id] = video.duration;
      piApi.media.update(id, { duration: video.duration }).catch(() => {});
      const card = document.querySelector(`.media-card[data-id="${id}"]`);
      const durEl = card?.querySelector(".media-duration");
      if (durEl) durEl.textContent = formatTime(video.duration);
    }
    video.currentTime = Math.min(1, video.duration * 0.1);
  });

  video.addEventListener(
    "seeked",
    () => {
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, 160, 90);
      try {
        state.thumbnailCache[id] = canvas.toDataURL("image/jpeg", 0.7);
      } catch {}
      video.src = "";
      video.load();
    },
    { once: true }
  );
}

function drawCachedThumb(canvas, dataUrl) {
  const img = new Image();
  img.onload = () => {
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = dataUrl;
}

let sharedScrubVideo = null;

function setupHoverScrub(thumbEl, videoUrl, canvas, itemId) {
  thumbEl.addEventListener("mouseenter", () => {
    if (!sharedScrubVideo) {
      sharedScrubVideo = document.createElement("video");
      sharedScrubVideo.crossOrigin = "anonymous";
      sharedScrubVideo.muted = true;
      sharedScrubVideo.preload = "auto";
    }
    if (sharedScrubVideo.src !== window.location.origin + videoUrl) {
      sharedScrubVideo.src = videoUrl;
    }
  });

  thumbEl.addEventListener("mousemove", (e) => {
    if (!sharedScrubVideo || !sharedScrubVideo.duration || !isFinite(sharedScrubVideo.duration))
      return;
    const rect = thumbEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = pct * sharedScrubVideo.duration;
    sharedScrubVideo.currentTime = time;

    sharedScrubVideo.addEventListener(
      "seeked",
      () => {
        const ctx = canvas.getContext("2d");
        ctx.drawImage(sharedScrubVideo, 0, 0, 160, 90);
      },
      { once: true }
    );
  });

  thumbEl.addEventListener("mouseleave", () => {
    if (state.thumbnailCache[itemId]) {
      drawCachedThumb(canvas, state.thumbnailCache[itemId]);
    }
  });
}

// =====================
// Attachment
// =====================

function toggleAttachment(id) {
  const idx = state.attachedIds.indexOf(id);
  if (idx !== -1) {
    state.attachedIds.splice(idx, 1);
  } else {
    state.attachedIds.push(id);
  }
  renderMediaBin();
}

function detachClip(id) {
  state.attachedIds = state.attachedIds.filter((aid) => aid !== id);
  renderMediaBin();
}

function renderAttachmentBar() {
  const bar = $("#chat-attachments");
  if (state.attachedIds.length === 0) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }

  bar.style.display = "flex";
  bar.innerHTML = state.attachedIds
    .map((id, i) => {
      const item = state.mediaItems.find((m) => m.id === id);
      if (!item) return "";
      const letter = String.fromCharCode(65 + i);
      return `
        <div class="chat-attach-chip" data-id="${escapeAttr(id)}">
          <span class="chip-letter">${letter}</span>
          <span class="chip-name">${escapeHtml(item.label)}</span>
          <button class="chip-remove" data-id="${escapeAttr(id)}">&times;</button>
        </div>
      `;
    })
    .join("");

  bar.querySelectorAll(".chip-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      detachClip(btn.dataset.id);
    });
  });
}

function updateChatInputState() {
  const input = $("#chat-input");
  input.disabled = state.processing;
  input.placeholder = "Message Pi...";
  updateSendButton();
}

function updateSendButton() {
  const btn = $("#send-btn");
  const hasText = ($("#chat-input").value || "").trim().length > 0;
  btn.disabled = !hasText && !state.chatStreaming;
}

// =====================
// @ Mention Autocomplete
// =====================

(function initMentionAutocomplete() {
  const input = $("#chat-input");
  const dropdown = $("#mention-dropdown");
  let mentionStart = -1;
  let activeIndex = 0;

  function getQuery() {
    if (mentionStart < 0) return null;
    const val = input.value;
    const cursor = input.selectionStart;
    if (cursor <= mentionStart) return null;
    return val.slice(mentionStart + 1, cursor).toLowerCase();
  }

  function getFilteredItems(query) {
    if (query === null) return [];
    if (!state.mediaItems.length) return [];
    if (query === "") return state.mediaItems.slice(0, 10);
    return state.mediaItems.filter((item) =>
      item.label.toLowerCase().includes(query)
    ).slice(0, 10);
  }

  function render(items) {
    if (items.length === 0 && mentionStart >= 0) {
      dropdown.innerHTML = '<div class="mention-empty">No matching media</div>';
      dropdown.classList.add("visible");
      return;
    }
    if (items.length === 0) {
      hide();
      return;
    }
    activeIndex = Math.min(activeIndex, items.length - 1);
    dropdown.innerHTML = items
      .map((item, i) =>
        `<div class="mention-item${i === activeIndex ? " active" : ""}" data-label="${escapeAttr(item.label)}">
          <span class="mention-type">${item.type}</span>
          <span class="mention-label">${escapeHtml(item.label)}</span>
        </div>`
      )
      .join("");
    dropdown.classList.add("visible");
  }

  function hide() {
    dropdown.classList.remove("visible");
    dropdown.innerHTML = "";
    mentionStart = -1;
    activeIndex = 0;
  }

  function apply(label) {
    const before = input.value.slice(0, mentionStart);
    const after = input.value.slice(input.selectionStart);
    input.value = before + "@" + label + " " + after;
    const newPos = mentionStart + 1 + label.length + 1;
    input.setSelectionRange(newPos, newPos);
    hide();
    input.focus();
    autoGrowTextarea(input);
    updateSendButton();
  }

  input.addEventListener("input", () => {
    const val = input.value;
    const cursor = input.selectionStart;

    if (mentionStart >= 0) {
      const query = getQuery();
      if (query === null) {
        hide();
      } else {
        activeIndex = 0;
        render(getFilteredItems(query));
      }
      return;
    }

    if (cursor > 0 && val[cursor - 1] === "@") {
      const charBefore = cursor > 1 ? val[cursor - 2] : " ";
      if (charBefore === " " || charBefore === "\n" || cursor === 1) {
        mentionStart = cursor - 1;
        activeIndex = 0;
        render(getFilteredItems(""));
      }
    }
  });

  input.addEventListener("keydown", (e) => {
    if (!dropdown.classList.contains("visible")) return;

    const items = getFilteredItems(getQuery());

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      render(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render(items);
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (items.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        apply(items[activeIndex].label);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });

  dropdown.addEventListener("click", (e) => {
    const item = e.target.closest(".mention-item");
    if (item) apply(item.dataset.label);
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target) && e.target !== input) {
      hide();
    }
  });
})();

// =====================
// Preview Panel
// =====================

function setupPreviewPanel() {
  $("#edit-this-btn").addEventListener("click", () => {
    if (!state.previewId) return;
    if (!state.attachedIds.includes(state.previewId)) {
      state.attachedIds = [state.previewId];
      renderMediaBin();
    }
    $("#chat-input").focus();
  });

  $("#in-out-reset").addEventListener("click", () => {
    if (!state.previewId) return;
    const item = state.mediaItems.find((m) => m.id === state.previewId);
    if (!item) return;
    item.inPoint = undefined;
    item.outPoint = undefined;
    piApi.media.update(state.previewId, { inPoint: null, outPoint: null }).catch(() => {});
    renderInOutControls();
  });

  setupInOutDrag();
}

function previewClip(id) {
  state.previewId = id;
  const item = state.mediaItems.find((m) => m.id === id);
  if (!item) return;

  $("#preview-placeholder").style.display = "none";
  const wrap = $("#preview-video-wrap");
  wrap.style.display = "flex";

  const video = $("#preview-video");
  if (video.src !== window.location.origin + item.url) {
    video.src = item.url;
  }

  const actions = $("#preview-actions");
  actions.style.display = "flex";
  const dlBtn = $("#download-btn");
  dlBtn.href = item.url;
  dlBtn.style.display = item.type === "output" ? "inline-flex" : "none";

  const meta = $("#preview-meta");
  const dur = item.duration || state.durations[id];
  const badgeClass = item.type === "upload" ? "badge-upload" : "badge-output";
  meta.innerHTML = `
    <span class="meta-label">${escapeHtml(item.label)}</span>
    <span class="meta-type ${badgeClass}">${item.type === "upload" ? "Source" : "Edit"}</span>
    ${dur ? `<span class="meta-duration">${formatTime(dur)}</span>` : ""}
  `;

  renderInOutControls();

  $$(".media-card").forEach((card) => {
    card.classList.toggle("previewing", card.dataset.id === id);
  });
}

function renderInOutControls() {
  const item = state.mediaItems.find((m) => m.id === state.previewId);
  if (!item) return;

  const dur = item.duration || state.durations[item.id] || 0;
  const range = $("#in-out-range");
  const inHandle = $("#in-handle");
  const outHandle = $("#out-handle");

  if (dur <= 0) {
    $("#in-out-controls").style.display = "none";
    return;
  }

  const inPt = Math.max(0, Math.min(item.inPoint || 0, dur));
  const outPt = Math.max(0, Math.min(item.outPoint || dur, dur));

  $("#in-out-controls").style.display = "block";

  const inPct = (inPt / dur) * 100;
  const outPct = (outPt / dur) * 100;

  range.style.left = inPct + "%";
  range.style.width = outPct - inPct + "%";
  inHandle.style.left = inPct + "%";
  outHandle.style.left = outPct + "%";

  $("#in-label").textContent = "I: " + formatTime(inPt);
  $("#out-label").textContent = "O: " + formatTime(outPt);
}

function setupInOutDrag() {
  let dragging = null;

  function onPointerDown(e, which) {
    e.preventDefault();
    dragging = which;
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragging || !state.previewId) return;
    const item = state.mediaItems.find((m) => m.id === state.previewId);
    if (!item) return;
    const dur = item.duration || state.durations[item.id] || 0;
    if (dur <= 0) return;

    const bar = $("#in-out-bar");
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = pct * dur;

    if (dragging === "in") {
      item.inPoint = Math.min(time, (item.outPoint || dur) - 0.1);
      if (item.inPoint < 0.05) item.inPoint = undefined;
    } else {
      item.outPoint = Math.max(time, (item.inPoint || 0) + 0.1);
      if (item.outPoint >= dur - 0.05) item.outPoint = undefined;
    }

    renderInOutControls();

    const video = $("#preview-video");
    const seekTo = dragging === "in" ? item.inPoint || 0 : item.outPoint || dur;
    video.currentTime = seekTo;
  }

  function onPointerUp() {
    if (dragging && state.previewId) {
      const item = state.mediaItems.find((m) => m.id === state.previewId);
      if (item) {
        piApi.media
          .update(state.previewId, {
            inPoint: item.inPoint || null,
            outPoint: item.outPoint || null,
          })
          .catch(() => {});
      }
    }
    dragging = null;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  }

  $("#in-handle").addEventListener("pointerdown", (e) => onPointerDown(e, "in"));
  $("#out-handle").addEventListener("pointerdown", (e) => onPointerDown(e, "out"));
}

// =====================
// Upload
// =====================

function uploadFile(file) {
  if (!file.type.startsWith("video/")) {
    showEditorError("Please select a video file.");
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    showEditorError("File is too large. Maximum size is 500MB.");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  const xhr = new XMLHttpRequest();
  const progressId = "upload-" + Date.now();
  showUploadProgress(progressId, file.name);

  xhr.upload.addEventListener("progress", (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      updateUploadProgress(progressId, pct);
    }
  });

  xhr.addEventListener("load", () => {
    removeUploadProgress(progressId);
    try {
      const data = JSON.parse(xhr.responseText);
      if (xhr.status !== 200 || data.error) {
        showEditorError(data.error || "Upload failed");
        return;
      }
      onUploadComplete(data);
    } catch {
      showEditorError("Upload failed — invalid response");
    }
  });

  xhr.addEventListener("error", () => {
    removeUploadProgress(progressId);
    showEditorError("Upload failed — network error");
  });

  xhr.open("POST", "/api/upload");
  xhr.send(formData);
}

function showUploadProgress(id, name) {
  let container = $("#upload-progress-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "upload-progress-container";
    $(".media-bin").prepend(container);
  }
  const el = document.createElement("div");
  el.className = "upload-progress-item";
  el.id = id;
  el.innerHTML = `
    <div class="upload-progress-name">${escapeHtml(name.slice(0, 30))}</div>
    <div class="upload-progress-bar"><div class="upload-progress-fill" style="width:0%"></div></div>
    <div class="upload-progress-pct">0%</div>
  `;
  container.appendChild(el);
}

function updateUploadProgress(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelector(".upload-progress-fill").style.width = pct + "%";
  el.querySelector(".upload-progress-pct").textContent = pct + "%";
}

function removeUploadProgress(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
  const container = $("#upload-progress-container");
  if (container && container.children.length === 0) container.remove();
}

function onUploadComplete(data) {
  state.mediaItems.unshift(data);
  state.attachedIds = [data.id];
  state.previewId = data.id;
  renderMediaBin();
  previewClip(data.id);
}

// =====================
// Chat System
// =====================

function sendChatMessage() {
  const input = $("#chat-input");
  const text = (input.value || "").trim();
  if (!text || state.processing) return;

  const attachedItems = state.attachedIds
    .map((id) => state.mediaItems.find((m) => m.id === id))
    .filter(Boolean);

  state.chatMessages.push({
    role: "user",
    text,
    clips: attachedItems.map((item, i) => ({
      id: item.id,
      label: item.label,
      letter: String.fromCharCode(65 + i),
    })),
  });

  renderChatMessages();

  input.value = "";
  autoGrowTextarea(input);

  state.processing = true;
  state.chatStreaming = true;
  updateChatInputState();
  setSendButtonStop(true);

  const chatStatus = $("#chat-status");
  chatStatus.textContent = "Processing...";
  chatStatus.className = "chat-status active";

  const agentMsg = {
    role: "agent",
    text: "",
    activity: [],
    outputId: null,
  };
  state.chatMessages.push(agentMsg);
  renderChatMessages();

  let currentThinkingText = "";
  let outputId = null;
  let userScrolledUp = false;
  const msgContainer = $("#chat-messages");

  msgContainer.addEventListener("scroll", () => {
    const atBottom = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < 30;
    userScrolledUp = !atBottom;
  });

  function scrollChat() {
    if (!userScrolledUp) {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }
  }

  function updateAgentMessage() {
    const msgEl = msgContainer.querySelector(".chat-msg-agent:last-child");
    if (!msgEl) return;

    const textEl = msgEl.querySelector(".chat-msg-text");
    if (textEl) {
      const display = agentMsg.displayText || agentMsg.text;
      textEl.textContent = display;
      textEl.style.display = display ? "" : "none";
    }

    const actEl = msgEl.querySelector(".chat-activity");
    if (actEl) {
      renderActivityInline(actEl, agentMsg.activity);
    }

    // Output card
    const existingOutput = msgEl.querySelector(".chat-output-card");
    if (!existingOutput && agentMsg.outputId) {
      const outputItem = state.mediaItems.find((m) => m.id === agentMsg.outputId);
      if (outputItem) {
        const card = document.createElement("div");
        card.className = "chat-output-card";
        card.dataset.id = agentMsg.outputId;
        card.innerHTML = `
          <canvas width="80" height="45" data-id="${escapeAttr(agentMsg.outputId)}"></canvas>
          <div class="output-info">
            <div class="output-name">${escapeHtml(outputItem.label)}</div>
            <div class="output-meta">Output ready</div>
          </div>
        `;
        const canvas = card.querySelector("canvas");
        if (state.thumbnailCache[agentMsg.outputId]) {
          drawCachedThumb(canvas, state.thumbnailCache[agentMsg.outputId]);
        }
        card.addEventListener("click", () => previewClip(agentMsg.outputId));
        msgEl.appendChild(card);
      }
    }

    const cursor = msgEl.querySelector(".streaming-cursor");
    if (!cursor && state.chatStreaming) {
      const textWrap = msgEl.querySelector(".chat-msg-text");
      if (textWrap) {
        textWrap.insertAdjacentHTML("afterend", '<span class="streaming-cursor"></span>');
      }
    }

    scrollChat();
  }

  function handleDelta(data) {
    currentThinkingText = "";
    agentMsg.text += data.text;
    // Strip OUTPUT_READY markers from visible text
    agentMsg.displayText = agentMsg.text.replace(/OUTPUT_READY:\S+/g, "").trim();
    updateAgentMessage();
  }

  function handleEvent(data) {
    switch (data.kind) {
      case "thinking":
        currentThinkingText += data.text;
        const existingThinking = agentMsg.activity.find(
          (a) => a.type === "thinking" && !a.done
        );
        if (existingThinking) {
          existingThinking.text = currentThinkingText;
        } else {
          agentMsg.activity.push({ type: "thinking", text: currentThinkingText, done: false });
        }
        updateAgentMessage();
        break;

      case "tool_start":
        currentThinkingText = "";
        const prevThinking = agentMsg.activity.find((a) => a.type === "thinking" && !a.done);
        if (prevThinking) prevThinking.done = true;
        agentMsg.activity.push({ type: "tool", name: data.tool, status: "running" });
        updateAgentMessage();
        break;

      case "tool_end": {
        const tool = [...agentMsg.activity].reverse().find(
          (a) => a.type === "tool" && a.name === data.tool
        );
        if (tool) tool.status = data.success ? "done" : "failed";
        updateAgentMessage();
        break;
      }

      case "turn_start":
        currentThinkingText = "";
        break;

      case "turn_end":
        break;

      case "compaction_start":
        agentMsg.activity.push({ type: "system", text: "Compacting context..." });
        updateAgentMessage();
        break;

      case "retry_start":
        agentMsg.activity.push({ type: "system", text: "Retrying..." });
        updateAgentMessage();
        break;
    }
  }

  async function handleOutputReady(data) {
    outputId = data.id;
    state.latestOutputId = data.id;
    agentMsg.outputId = data.id;
    agentMsg.displayText = (agentMsg.displayText || agentMsg.text || "")
      .replace(/OUTPUT_READY:\S+/g, "").trim();
    await fetchMediaLibrary();
    previewClip(data.id);
    updateAgentMessage();
  }

  function handleDone() {
    // Clean up display text
    agentMsg.displayText = (agentMsg.displayText || agentMsg.text || "")
      .replace(/OUTPUT_READY:\S+/g, "").trim();

    cleanup();
    chatStatus.textContent = outputId ? "Done" : "";
    chatStatus.className = "chat-status";

    const msgEl = msgContainer.querySelector(".chat-msg-agent:last-child");
    if (msgEl) {
      const cursor = msgEl.querySelector(".streaming-cursor");
      if (cursor) cursor.remove();
      const textEl = msgEl.querySelector(".chat-msg-text");
      if (textEl) {
        textEl.textContent = agentMsg.displayText;
        textEl.style.display = agentMsg.displayText ? "" : "none";
      }
    }

    collapseActivityInLastMessage();

    // Ensure output is loaded into preview
    if (outputId) {
      previewClip(outputId);
    }
  }

  function handleError(data) {
    agentMsg.text += "\n[Error: " + data.message + "]";
    cleanup();
    chatStatus.textContent = "Error";
    chatStatus.className = "chat-status";
    updateAgentMessage();
  }

  function cleanup() {
    piApi.removeAllListeners("agent:delta");
    piApi.removeAllListeners("agent:done");
    piApi.removeAllListeners("agent:error");
    piApi.removeAllListeners("agent:event");
    piApi.removeAllListeners("agent:output-ready");

    state.processing = false;
    state.chatStreaming = false;
    updateChatInputState();
    setSendButtonStop(false);
  }

  piApi.on("agent:delta", handleDelta);
  piApi.on("agent:event", handleEvent);
  piApi.on("agent:output-ready", handleOutputReady);
  piApi.on("agent:done", handleDone);
  piApi.on("agent:error", handleError);

  let messageText = text;
  if (attachedItems.length > 0) {
    const fileRefs = attachedItems.map((item) => `@${item.label}`).join(", ");
    messageText = `[Attached files: ${fileRefs}]\n${text}`;
  }

  state.attachedIds = [];
  renderAttachmentBar();
  renderMediaBin();

  fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: messageText }),
  })
    .then(async (response) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = null;
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              piApi._emit("agent:" + currentEvent, data);
            } catch {}
            currentEvent = null;
          }
        }
      }
    })
    .catch((err) => {
      handleError({ message: err.message });
    });
}

function stopStreaming() {
  state.chatStreaming = false;
  setSendButtonStop(false);
}

function setSendButtonStop(isStop) {
  const btn = $("#send-btn");
  if (isStop) {
    btn.classList.add("stop-btn");
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/></svg>';
  } else {
    btn.classList.remove("stop-btn");
    btn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg>';
    updateSendButton();
  }
}

// =====================
// Chat Rendering
// =====================

function renderChatMessages() {
  const container = $("#chat-messages");
  container.innerHTML = "";

  state.chatMessages.forEach((msg) => {
    const el = document.createElement("div");
    el.className = "chat-msg " + (msg.role === "user" ? "chat-msg-user" : "chat-msg-agent");

    let html = "";

    html += `<div class="chat-msg-sender">${msg.role === "user" ? "You" : "Agent"}</div>`;

    if (msg.clips && msg.clips.length > 0) {
      html += '<div class="chat-msg-clips">';
      msg.clips.forEach((clip) => {
        html += `
          <div class="chat-clip-chip" data-id="${escapeAttr(clip.id)}">
            <span class="chip-letter">${escapeHtml(clip.letter)}</span>
            <span>${escapeHtml(clip.label)}</span>
          </div>
        `;
      });
      html += "</div>";
    }

    if (msg.role === "agent" && msg.activity) {
      html += '<div class="chat-activity"></div>';
    }

    const displayText = msg.role === "agent" ? (msg.displayText || msg.text || "").replace(/OUTPUT_READY:\S+/g, "").trim() : msg.text;
    html += `<div class="chat-msg-text" ${!displayText ? 'style="display:none"' : ""}>${escapeHtml(displayText)}</div>`;

    if (msg.role === "agent" && state.chatStreaming && msg === state.chatMessages[state.chatMessages.length - 1]) {
      html += '<span class="streaming-cursor"></span>';
    }

    if (msg.outputId) {
      const outputItem = state.mediaItems.find((m) => m.id === msg.outputId);
      if (outputItem) {
        html += `
          <div class="chat-output-card" data-id="${escapeAttr(msg.outputId)}">
            <canvas width="80" height="45" data-id="${escapeAttr(msg.outputId)}"></canvas>
            <div class="output-info">
              <div class="output-name">${escapeHtml(outputItem.label)}</div>
              <div class="output-meta">Output ready — click to preview</div>
            </div>
          </div>
        `;
      }
    }

    el.innerHTML = html;

    if (msg.role === "agent" && msg.activity) {
      const actEl = el.querySelector(".chat-activity");
      if (actEl) renderActivityInline(actEl, msg.activity);
    }

    container.appendChild(el);
  });

  container.querySelectorAll(".chat-output-card").forEach((card) => {
    const id = card.dataset.id;
    const canvas = card.querySelector("canvas");
    if (canvas && state.thumbnailCache[id]) {
      drawCachedThumb(canvas, state.thumbnailCache[id]);
    }
    card.addEventListener("click", () => previewClip(id));
  });

  container.querySelectorAll(".chat-clip-chip").forEach((chip) => {
    chip.addEventListener("click", () => previewClip(chip.dataset.id));
  });

  container.scrollTop = container.scrollHeight;
}

function renderActivityInline(container, activities) {
  if (!activities || activities.length === 0) {
    container.innerHTML = "";
    return;
  }

  const isStreaming = state.chatStreaming;
  const tools = activities.filter((a) => a.type === "tool");
  const failedTools = tools.filter((a) => a.status === "failed");
  const runningTool = tools.find((a) => a.status === "running");
  const activeThinking = activities.find((a) => a.type === "thinking" && !a.done);
  const toolCount = tools.length;

  let html = "";

  if (isStreaming) {
    // During streaming: show thinking text or current tool, nothing else
    if (activeThinking && activeThinking.text) {
      const thinkingPreview = activeThinking.text.length > 200
        ? activeThinking.text.slice(-200) + "..."
        : activeThinking.text;
      html += `<div class="chat-activity-item chat-activity-thinking">`
        + `<div class="activity-spinner"></div>`
        + `<span class="chat-activity-label">Thinking</span></div>`
        + `<div class="chat-thinking-text">${escapeHtml(thinkingPreview)}</div>`;
    } else if (runningTool) {
      const doneCount = tools.filter((a) => a.status === "done").length;
      const label = doneCount > 0
        ? `Running ${escapeHtml(runningTool.name)} (${doneCount + 1}/${toolCount})`
        : `Running ${escapeHtml(runningTool.name)}`;
      html += `<div class="chat-activity-item chat-activity-tool">`
        + `<div class="activity-spinner"></div>`
        + `<span class="chat-activity-label">${label}</span></div>`;
    }

    // Show any failures immediately
    failedTools.forEach((t) => {
      html += `<div class="chat-activity-item chat-activity-tool-fail">`
        + `<span class="chat-activity-label">${escapeHtml(t.name)}</span>`
        + `<span class="chat-activity-detail">failed</span></div>`;
    });
  } else {
    // After done: compact summary
    if (toolCount > 0 || failedTools.length > 0) {
      const doneCount = tools.filter((a) => a.status === "done").length;
      const summaryParts = [];
      if (doneCount > 0) summaryParts.push(`${doneCount} step${doneCount > 1 ? "s" : ""}`);
      if (failedTools.length > 0) summaryParts.push(`${failedTools.length} failed`);
      const summaryText = summaryParts.join(", ");

      html += `<div class="chat-activity-summary" onclick="this.classList.toggle('expanded')">`
        + `<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>`
        + `<span>${summaryText}</span></div>`;
      html += '<div class="chat-activity-collapsed">';
      tools.forEach((t) => {
        let cls = t.status === "done" ? "chat-activity-tool-done" : "chat-activity-tool-fail";
        html += `<div class="chat-activity-item ${cls}">`
          + `<span class="chat-activity-label">${escapeHtml(t.name)}</span>`
          + `<span class="chat-activity-detail">${t.status}</span></div>`;
      });
      html += "</div>";
    }
  }

  container.innerHTML = html;
}

function collapseActivityInLastMessage() {
  const container = $("#chat-messages");
  const lastMsg = container.querySelector(".chat-msg-agent:last-child");
  if (!lastMsg) return;
  const actEl = lastMsg.querySelector(".chat-activity");
  if (!actEl) return;
  const lastAgentMsg = state.chatMessages.filter((m) => m.role === "agent").pop();
  if (lastAgentMsg) {
    renderActivityInline(actEl, lastAgentMsg.activity);
  }
}

// =====================
// Resize Handles
// =====================

function setupResizeHandles() {
  setupResize("resize-left", "--media-w", 180, 400);
  setupResize("resize-right", "--chat-w", 280, 520, true);
}

function setupResize(handleId, cssVar, min, max, invert) {
  const handle = document.getElementById(handleId);
  if (!handle) return;

  let startX, startWidth;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.classList.add("active");
    startX = e.clientX;
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || (cssVar === "--media-w" ? 260 : 380);
    startWidth = current;

    const onMove = (e) => {
      const delta = invert ? startX - e.clientX : e.clientX - startX;
      const newWidth = Math.max(min, Math.min(max, startWidth + delta));
      document.documentElement.style.setProperty(cssVar, newWidth + "px");
    };

    const onUp = () => {
      handle.classList.remove("active");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

// =====================
// Auto-grow Textarea
// =====================

function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}

// =====================
// Errors & Utilities
// =====================

function showEditorError(msg) {
  const existing = $(".workspace .error-banner");
  if (existing) existing.remove();
  $(".workspace").insertAdjacentHTML(
    "afterbegin",
    `<div class="error-banner">${escapeHtml(msg)}</div>`
  );
  setTimeout(() => {
    const banner = $(".workspace .error-banner");
    if (banner) banner.remove();
  }, 5000);
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ":" + s.toString().padStart(2, "0");
}

// =====================
// Init
// =====================

document.addEventListener("DOMContentLoaded", () => {
  checkStatus();
  initUpdateUI();
});

// =====================
// Auto-update UI
// =====================

function initUpdateUI() {
  const banner = document.getElementById("update-banner");
  const text = document.getElementById("update-banner-text");
  const installBtn = document.getElementById("update-install-btn");
  const closeBtn = document.getElementById("update-banner-close");
  const checkBtn = document.getElementById("check-updates-btn");
  if (!banner) return;

  let dismissedForVersion = null;
  let manualCheck = false;

  function render(s) {
    if (!s) return;
    switch (s.status) {
      case "available":
        if (dismissedForVersion === s.version) return;
        text.textContent = `Update available: v${s.version}. Downloading…`;
        installBtn.hidden = true;
        banner.hidden = false;
        break;
      case "downloading":
        if (dismissedForVersion === s.version) return;
        text.textContent = `Downloading update${s.version ? " v" + s.version : ""}: ${s.percent || 0}%`;
        installBtn.hidden = true;
        banner.hidden = false;
        break;
      case "ready":
        text.textContent = `Update v${s.version} ready.`;
        installBtn.hidden = false;
        banner.hidden = false;
        break;
      case "none":
        if (manualCheck) {
          text.textContent = `You're on the latest version (v${s.version || ""}).`;
          installBtn.hidden = true;
          banner.hidden = false;
          setTimeout(() => {
            if (banner && text.textContent.startsWith("You're on the latest")) banner.hidden = true;
          }, 4000);
          manualCheck = false;
        }
        break;
      case "error":
        if (manualCheck) {
          text.textContent = `Update check failed: ${s.message}`;
          installBtn.hidden = true;
          banner.hidden = false;
          manualCheck = false;
        }
        break;
      default:
        break;
    }
  }

  async function poll() {
    try {
      const res = await fetch("/api/update/status");
      const data = await res.json();
      render(data);
    } catch {}
  }

  closeBtn?.addEventListener("click", () => {
    const current = text.textContent.match(/v([\d.]+)/);
    dismissedForVersion = current ? current[1] : "dismissed";
    banner.hidden = true;
  });

  installBtn?.addEventListener("click", async () => {
    installBtn.disabled = true;
    installBtn.textContent = "Restarting…";
    try {
      await fetch("/api/update/install", { method: "POST" });
    } catch {}
  });

  checkBtn?.addEventListener("click", async () => {
    checkBtn.disabled = true;
    const original = checkBtn.textContent;
    checkBtn.textContent = "Checking…";
    manualCheck = true;
    try {
      const res = await fetch("/api/update/check", { method: "POST" });
      const data = await res.json();
      render(data);
    } catch {}
    checkBtn.disabled = false;
    checkBtn.textContent = original;
  });

  // Initial poll + interval
  poll();
  setInterval(poll, 15000);
}
