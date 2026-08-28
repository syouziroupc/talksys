const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session } = require('electron');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');

const DEFAULT_API_BASE = process.env.TALKSYS_API_BASE || 'https://talksys.syouziroupc.workers.dev';
let mainWindow = null;
let overlayWindow = null;
let overlayReady = false;
let pendingArrow = null;

function normalizeApiBase(value) {
  const url = new URL(String(value || DEFAULT_API_BASE).trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API URL は http または https にしてください');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

async function postApi(route, body, apiBase) {
  const base = normalizeApiBase(apiBase);
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('APIからJSON応答を取得できませんでした');
  }
  if (!response.ok) throw new Error(data.error || `API error ${response.status}`);
  return data;
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
    width: 520,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    title: 'TalkSys Desktop',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    overlayWindow = null;
    overlayReady = false;
    pendingArrow = null;
    if (process.platform !== 'darwin') app.quit();
  });
}

function sendPendingArrow() {
  if (!overlayReady || !pendingArrow || !overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('overlay:show', pendingArrow);
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  overlayReady = false;
  overlayWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayReady = true;
    sendPendingArrow();
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayReady = false;
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capturePrimary(maxWidth = 1024, maxHeight = 720) {
  const display = screen.getPrimaryDisplay();
  const width = Math.max(1, display.bounds.width);
  const height = Math.max(1, display.bounds.height);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const thumbnailSize = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };

  const restoreOverlay = Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
  if (restoreOverlay) {
    overlayWindow.hide();
    await delay(80);
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
      fetchWindowIcons: false,
    });
    const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('デスクトップ画像を取得できませんでした');
    const jpeg = source.thumbnail.toJPEG(76);
    return {
      display,
      dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      png: source.thumbnail.toPNG(),
    };
  } finally {
    if (restoreOverlay && overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.showInactive();
  }
}

function showArrow(target, display) {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  const bounds = (display || screen.getPrimaryDisplay()).bounds;
  overlayWindow.setBounds(bounds, false);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  pendingArrow = {
    x: Math.max(0, Math.min(1000, Number(target.x) || 0)),
    y: Math.max(0, Math.min(1000, Number(target.y) || 0)),
    label: String(target.label || 'ここです').slice(0, 120),
  };
  sendPendingArrow();
  overlayWindow.showInactive();
}

function clearArrow() {
  pendingArrow = null;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayReady) overlayWindow.webContents.send('overlay:clear');
  overlayWindow.hide();
}

ipcMain.handle('config:get', () => ({ apiBase: DEFAULT_API_BASE }));

ipcMain.handle('chat:send', async (_event, payload) => {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return postApi('/api/chat', { messages }, payload?.apiBase);
});

ipcMain.handle('guide:locate', async (_event, payload) => {
  const query = String(payload?.query || '').trim();
  if (!query) throw new Error('何を探すか指定してください');
  const frame = await capturePrimary();
  const result = await postApi('/api/locate', { query, image: frame.dataUrl }, payload?.apiBase);
  if (result.found) showArrow(result, frame.display);
  else clearArrow();
  return result;
});

ipcMain.handle('overlay:clear', () => {
  clearArrow();
  return true;
});

ipcMain.handle('capture:save', async () => {
  const display = screen.getPrimaryDisplay();
  const frame = await capturePrimary(display.bounds.width, display.bounds.height);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'デスクトップキャプチャーを保存',
    defaultPath: `talksys-screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };
  await writeFile(result.filePath, frame.png);
  return { saved: true, filePath: result.filePath };
});

app.whenReady().then(() => {
  configureMediaPermissions();
  createMainWindow();
  createOverlayWindow();

  screen.on('display-metrics-changed', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.setBounds(screen.getPrimaryDisplay().bounds, false);
  });

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
