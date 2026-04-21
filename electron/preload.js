const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke("recruitme:open-external", url),
});
