const { app, BrowserWindow, session } = require('electron');

const DEFAULT_APP_URL = process.env.TALKSYS_API_BASE || 'https://talksys.syouziroupc.workers.dev';
let mainWindow = null;

function normalizeAppUrl(value) {
  const url = new URL(String(value || DEFAULT_APP_URL).trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('TalkSys URL must use http or https');
  url.hash = '';
  return url.toString();
}

function isTrustedMainWindow(webContents) {
  return Boolean(
    webContents &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    webContents.id === mainWindow.webContents.id
  );
}

function configureMediaPermissions() {
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media' && isTrustedMainWindow(webContents);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && isTrustedMainWindow(webContents));
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 860,
    minWidth: 390,
    minHeight: 620,
    title: 'TalkSys 電話相談',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadURL(normalizeAppUrl(DEFAULT_APP_URL));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (process.platform !== 'darwin') app.quit();
  });
}

app.whenReady().then(() => {
  configureMediaPermissions();
  createMainWindow();
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
