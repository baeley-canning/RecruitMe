// Minimal preload — the app runs as a standard web app inside Electron.
// No special IPC needed; all functionality goes through the Next.js API routes.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
});
