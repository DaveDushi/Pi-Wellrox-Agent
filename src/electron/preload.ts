import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  startup: {
    getStatus: () => ipcRenderer.invoke("startup:status"),
    initiateAuth: () => ipcRenderer.invoke("startup:auth"),
    getAuthStatus: () => ipcRenderer.invoke("startup:auth-status"),
    getModels: () => ipcRenderer.invoke("startup:models"),
    selectModel: (modelId: string) =>
      ipcRenderer.invoke("startup:select-model", modelId),
  },
  media: {
    list: () => ipcRenderer.invoke("media:list"),
    update: (id: string, data: any) =>
      ipcRenderer.invoke("media:update", id, data),
    remove: (id: string) => ipcRenderer.invoke("media:delete", id),
  },
  agent: {
    chat: (data: any) => ipcRenderer.send("agent:chat", data),
    resetSession: () => ipcRenderer.invoke("agent:reset"),
  },
  on: (channel: string, callback: (...args: any[]) => void) => {
    const valid = [
      "agent:delta",
      "agent:done",
      "agent:error",
      "agent:event",
      "agent:output-ready",
    ];
    if (!valid.includes(channel)) return;
    ipcRenderer.on(channel, (_event: any, ...args: any[]) =>
      callback(...args)
    );
  },
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
