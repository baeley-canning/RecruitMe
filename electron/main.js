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

const MAC_BROWSER_CANDIDATES = [
  { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  { name: "Opera", path: "/Applications/Opera.app/Contents/MacOS/Opera" },
  { name: "Opera GX", path: "/Applications/Opera GX.app/Contents/MacOS/Opera GX" },
  { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
  { name: "Brave Browser", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
];

function findSupportedBrowser() {
  if (process.platform === "darwin") {
    return MAC_BROWSER_CANDIDATES.find((browser) => fs.existsSync(browser.path)) ?? null;
  }

  if (process.platform !== "win32") return null;

  try {
    const ps = `
$found = $null
$foundName = $null
$lad = [Environment]::GetFolderPath('LocalApplicationData')
$pf  = [Environment]::GetFolderPath('ProgramFiles')
$pf86= [Environment]::GetFolderPath('ProgramFilesX86')
$candidates = @(
  @{ Name = "Google Chrome"; Paths = @("$pf\\Google\\Chrome\\Application\\chrome.exe", "$pf86\\Google\\Chrome\\Application\\chrome.exe", "$lad\\Google\\Chrome\\Application\\chrome.exe") },
  @{ Name = "Opera"; Paths = @("$lad\\Programs\\Opera\\launcher.exe", "$lad\\Programs\\Opera\\opera.exe", "$pf\\Opera\\launcher.exe", "$pf86\\Opera\\launcher.exe") },
  @{ Name = "Opera GX"; Paths = @("$lad\\Programs\\Opera GX\\launcher.exe", "$lad\\Programs\\Opera GX\\opera.exe", "$pf\\Opera GX\\launcher.exe", "$pf86\\Opera GX\\launcher.exe") },
  @{ Name = "Microsoft Edge"; Paths = @("$pf\\Microsoft\\Edge\\Application\\msedge.exe", "$pf86\\Microsoft\\Edge\\Application\\msedge.exe", "$lad\\Microsoft\\Edge\\Application\\msedge.exe") },
  @{ Name = "Brave Browser"; Paths = @("$pf\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", "$pf86\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", "$lad\\BraveSoftware\\Brave-Browser\\Application\\brave.exe") }
)
foreach ($candidate in $candidates) {
  foreach ($p in $candidate.Paths) {
    if (Test-Path $p) {
      $found = $p
      $foundName = $candidate.Name
      break
    }
  }
  if ($found) { break }
}
if (-not $found) {
  $commands = @(
    @{ Name = "Google Chrome"; Command = "chrome.exe" },
    @{ Name = "Microsoft Edge"; Command = "msedge.exe" },
    @{ Name = "Brave Browser"; Command = "brave.exe" },
    @{ Name = "Opera"; Command = "opera.exe" }
  )
  foreach ($entry in $commands) {
    $cmd = Get-Command $entry.Command -ErrorAction SilentlyContinue
    if ($cmd) {
      $found = $cmd.Source
      $foundName = $entry.Name
      break
    }
  }
}
if ($found) { Write-Output ($foundName + "|" + $found) }
`;
    const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8", timeout: 8000,
    }).trim();

    const [name, browserPath] = result.split("|");
    if (name && browserPath && fs.existsSync(browserPath)) {
      console.log("[browser] found at:", browserPath);
      return { name, path: browserPath };
    }
    console.warn("[browser] PowerShell search returned nothing");
  } catch (err) {
    console.warn("[browser] PowerShell search failed:", err.message);
  }
  return null;
}

function openInSupportedBrowser(url) {
  const browser = findSupportedBrowser();
  if (!browser) return { ok: false, browser: null };
  try {
    const child = spawn(browser.path, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, browser: browser.name };
  } catch (err) {
    console.error("[browser] spawn failed:", err);
    return { ok: false, browser: browser.name };
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

// Opens a LinkedIn URL in a supported Chromium browser so the RecruitMe extension can capture it.
ipcMain.handle("recruitme:open-external", (_event, url) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return { ok: false, browser: null };
  }
  return openInSupportedBrowser(url);
});
