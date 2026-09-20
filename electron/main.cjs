/**
 * Electron shell — double-click LMS Buddy.exe, no npm required at runtime.
 */
const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");

let mainWindow = null;
let httpServer = null;

async function boot() {
  const isPackaged = app.isPackaged;
  const appRoot = isPackaged ? app.getAppPath() : path.join(__dirname, "..");
  const dataDir = path.join(app.getPath("userData"), "data");

  // One-time migrate from old npm `data/config.json` if present
  const fs = require("node:fs");
  const legacyCfg = path.join(appRoot, "data", "config.json");
  const destCfg = path.join(dataDir, "config.json");
  if (!fs.existsSync(destCfg) && fs.existsSync(legacyCfg)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(legacyCfg, destCfg);
  }

  process.env.LMS_BUDDY_ROOT = appRoot;
  process.env.LMS_BUDDY_DATA_DIR = dataDir;
  process.env.LMS_BUDDY_NO_OPEN = "1";

  // Dynamic import ESM server from CJS
  const { setPaths } = await import(
    pathToFileUrl(path.join(appRoot, "server", "config.js"))
  );
  setPaths({ root: appRoot, dataDir });

  const { startServer } = await import(
    pathToFileUrl(path.join(appRoot, "server", "index.js"))
  );

  const { server, url } = await startServer({
    port: 3847,
    openBrowser: false,
  });
  httpServer = server;

  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 280,
    title: "LMS Buddy",
    autoHideMenuBar: true,
    backgroundColor: "#0e1412",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(url);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function pathToFileUrl(p) {
  let resolved = path.resolve(p);
  if (process.platform === "win32") {
    resolved = "/" + resolved.replace(/\\/g, "/");
  }
  return "file://" + resolved;
}

app.whenReady().then(() => {
  boot().catch((err) => {
    console.error(err);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (httpServer) {
    try {
      httpServer.close();
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});
