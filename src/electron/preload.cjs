const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  startup: {
    getStatus: () => ipcRenderer.invoke("startup:status"),
    initiateAuth: () => ipcRenderer.invoke("startup:auth"),
    getAuthStatus: () => ipcRenderer.invoke("startup:auth-status"),
    getModels: () => ipcRenderer.invoke("startup:models"),
    selectModel: (modelId) =>
      ipcRenderer.invoke("startup:select-model", modelId),
  },
  media: {
    list: () => ipcRenderer.invoke("media:list"),
    update: (id, data) => ipcRenderer.invoke("media:update", id, data),
    remove: (id) => ipcRenderer.invoke("media:delete", id),
  },
  agent: {
    processVideo: (data) => ipcRenderer.send("agent:process-video", data),
    resetSession: () => ipcRenderer.invoke("agent:reset"),
  },
  on: (channel, callback) => {
    const valid = [
      "agent:delta",
      "agent:done",
      "agent:error",
      "agent:event",
      "agent:output-ready",
    ];
    if (!valid.includes(channel)) return;
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
