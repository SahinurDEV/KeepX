import { app, BrowserWindow, globalShortcut, ipcMain, Notification, shell } from "electron";
import path from "node:path";
import { isAllowedNavigation, isAppUrl, isExternalHttp, readNotice } from "./security.js";

const appOrigin = process.env.KEEPX_WEB_ORIGIN?.trim() || "http://127.0.0.1:3000";
const shortcut = "CommandOrControl+Shift+K";

function openOutside(url: string): void {
  if (isExternalHttp(url)) void shell.openExternal(url);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: "KeepX",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url, appOrigin)) return { action: "allow" };
    openOutside(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url, appOrigin)) return;
    event.preventDefault();
    openOutside(url);
  });

  let showingError = false;
  win.webContents.on("did-navigate", (_event, url) => {
    if (isAppUrl(url, appOrigin)) showingError = false;
  });
  win.webContents.on("did-fail-load", (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || showingError) return;
    if (!isAllowedNavigation(url, appOrigin)) return;
    showingError = true;
    void win.loadFile(path.join(__dirname, "../static/offline.html"), { query: { origin: appOrigin } });
  });

  void win.loadURL(appOrigin);
  return win;
}

function focusWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send("quick-add");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => focusWindow());

  app.whenReady().then(() => {
    ipcMain.handle("notify", (event, payload: unknown) => {
      const notice = readNotice(payload);
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!notice || !owner || !Notification.isSupported()) return false;
      new Notification({ title: notice.title, body: notice.body }).show();
      return true;
    });

    createWindow();
    globalShortcut.register(shortcut, () => focusWindow());

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
