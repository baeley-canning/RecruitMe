const { app, BrowserWindow, shell, dialog, ipcMain } = require("electron");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const net = require("net");
const fs = require("fs");

const isDev = !app.isPackaged;
const DEV_PORT = 3000;

let mainWindow = null;
let serverProcess = null;
let activePort = DEV_PORT;

function findOperaExecutable() {
  if (process.platform === "darwin") {
    const macPaths = [
      "/Applications/Opera.app/Contents/MacOS/Opera",
      "/Applications/Opera GX.app/Contents/MacOS/Opera GX",
    ];
    return macPaths.find((p) => fs.existsSync(p)) ?? null;
  }

  if (process.platform !== "win32") return null;

  // Use PowerShell — it has access to Windows env/registry regardless of how Electron was launched
  try {
    const ps = `
$found = $null
$lad = [Environment]::GetFolderPath('LocalApplicationData')
$pf  = [Environment]::GetFolderPath('ProgramFiles')
$pf86= [Environment]::GetFolderPath('ProgramFilesX86')
$paths = @(
  "$lad\\Programs\\Opera\\launcher.exe",
  "$lad\\Programs\\Opera\\opera.exe",
  "$lad\\Programs\\Opera GX\\launcher.exe",
  "$lad\\Programs\\Opera GX\\opera.exe",
  "$pf\\Opera\\launcher.exe",
  "$pf\\Opera GX\\launcher.exe",
  "$pf86\\Opera\\launcher.exe",
  "$pf86\\Opera GX\\launcher.exe"
)
foreach ($p in $paths) { if (Test-Path $p) { $found = $p; break } }
if (-not $found) {
  $cmd = Get-Command opera.exe -ErrorAction SilentlyContinue
  if ($cmd) { $found = $cmd.Source }
}
if (-not $found) {
  $regKey = 'HKCU:\\SOFTWARE\\Clients\\StartMenuInternet\\OperaStable\\shell\\open\\command'
  try {
    $val = (Get-ItemProperty -Path $regKey -ErrorAction Stop).'(Default)'
    $exe = ($val -replace '"','') -replace ' .*',''
    if (Test-Path $exe) { $found = $exe }
  } catch {}
}
if ($found) { Write-Output $found }
`;
    const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8", timeout: 8000,
    }).trim();

    if (result && fs.existsSync(result)) {
      console.log("[opera] found at:", result);
      return result;
    }
    console.warn("[opera] PowerShell search returned nothing");
  } catch (err) {
    console.warn("[opera] PowerShell search failed:", err.message);
  }
  return null;
}

/** Open a URL in Opera. Returns true if Opera was found and launched, false otherwise. */
function openInOpera(url) {
  const exe = findOperaExecutable();
  if (!exe) return false;
  try {
    const child = spawn(exe, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (err) {
    console.error("[opera] spawn failed:", err);
    return false;
  }
}

// ── Port helpers ──────────────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getPreferredPort(preferredPort) {
  if (await canBindPort(preferredPort)) return preferredPort;
  return getFreePort();
}

function waitForPort(port, maxMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs;
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        if (Date.now() > deadline) return reject(new Error("Server did not start in time"));
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

// ── Database setup ────────────────────────────────────────────────────────────

function ensureDatabase() {
  const userDataPath = app.getPath("userData");
  const dbPath = path.join(userDataPath, "recruitme.db");

  if (!fs.existsSync(dbPath)) {
    // Copy the bundled seed database on first run
    const seedDb = isDev
      ? path.join(__dirname, "..", "prisma", "seed.db")
      : path.join(app.getAppPath(), "prisma", "seed.db");

    if (fs.existsSync(seedDb)) {
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.copyFileSync(seedDb, dbPath);
      console.log("[db] Copied seed database to", dbPath);
    } else {
      console.warn("[db] No seed.db found — database will be created empty");
    }
  }

  return dbPath;
}

// ── Next.js server ────────────────────────────────────────────────────────────

function startProductionServer(port, dbPath) {
  const appRoot = app.getAppPath();
  const standalone = path.join(appRoot, ".next", "standalone");
  const serverJs = path.join(standalone, "server.js");

  if (!fs.existsSync(serverJs)) {
    throw new Error(`Bundled server not found at: ${serverJs}\nRun 'npm run electron:build' first.`);
  }

  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: "production",
    DATABASE_URL: `file:${dbPath}`,
    NEXTAUTH_URL: `http://localhost:${port}`,
    // Fixed secret for the desktop build — safe because server only binds to localhost
    NEXTAUTH_SECRET: "recruitme-desktop-2024-x04NrrFE401nkGNG4bSttqYYDM8brzx",
  };

  serverProcess = spawn(process.execPath, [serverJs], {
    cwd: standalone,
    env,
    stdio: "pipe",
  });

  serverProcess.stdout.on("data", (d) => console.log("[next]", d.toString().trim()));
  serverProcess.stderr.on("data", (d) => console.error("[next]", d.toString().trim()));
  serverProcess.on("exit", (code) => {
    console.log("[next] server exited with code", code);
    serverProcess = null;
  });
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(port) {
  if (mainWindow) { mainWindow.focus(); return; }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "RecruitMe",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${port}`);
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // External links open in the system default browser (not the Electron window)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://localhost:${port}`)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`http://localhost:${port}`)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    if (isDev) {
      // Dev: Next.js dev server is already running
      activePort = DEV_PORT;
    } else {
      activePort = await getPreferredPort(DEV_PORT);
      const dbPath = ensureDatabase();
      startProductionServer(activePort, dbPath);
      await waitForPort(activePort);
    }
    createWindow(activePort);
  } catch (err) {
    dialog.showErrorBox("RecruitMe — Startup Error", String(err));
    app.quit();
  }
});

app.on("activate", () => {
  // macOS: re-open window when clicking dock icon
  createWindow(activePort);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (serverProcess) { serverProcess.kill(); serverProcess = null; }
    app.quit();
  }
});

app.on("before-quit", () => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
});

// Opens a LinkedIn URL specifically in Opera (required for the capture extension).
// Returns true if Opera was found and launched, false if Opera isn't installed.
ipcMain.handle("recruitme:open-external", (_event, url) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  return openInOpera(url);
});
