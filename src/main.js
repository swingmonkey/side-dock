'use strict';
/**
 * Side Dock — a draggable, magnetically snapped desktop sidebar showing
 * DeepSeek balance, OpenCode Go quota, token usage and system stats.
 *
 * This is a standalone Electron app: it reads DSH session logs and provider
 * APIs directly, so DSH does not need to be running.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { clamp, nearestEdge, snapEdge, resolveBounds } = require('./geometry.js');
const { collectSnapshot } = require('./data');

const POLL_MS = 2000;
const MIN_WIDTH = 72;
const MAX_WIDTH = 460;
const MIN_HEIGHT = 90;
const SNAP_THRESHOLD = 56;
const DUMP_MODE = process.argv.includes('--dump-stats');

app.setName('Side Dock');

// ------------------------------------------------------------------ logging

let logStream = null;
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    process.stdout.write('[side-dock] ' + line + '\n');
  } catch {
    /* stdout closed */
  }
  try {
    if (!logStream) {
      const dir = path.join(app.getPath('logs'));
      fs.mkdirSync(dir, { recursive: true });
      logStream = fs.createWriteStream(path.join(dir, 'main.log'), { flags: 'a' });
    }
    logStream.write(line + '\n');
  } catch {
    /* logging is best effort */
  }
}

process.on('uncaughtException', (error) => {
  log('uncaught exception: ' + (error && error.stack ? error.stack : String(error)));
});
process.on('unhandledRejection', (reason) => {
  log('unhandled rejection: ' + String(reason));
});

// ------------------------------------------------------------------ window

let win = null;
let latest = null;
let pollTimer = null;
let moveSettleTimer = null;
let boundsTimer = null;
let ignoreMovesUntil = 0;
let dragging = false;
let pendingShow = true;

const position = { snap: 'left', x: null, y: null, width: 0, height: 0 };

function stateFile() {
  return path.join(app.getPath('userData'), 'window.json');
}

function loadPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.snap === null) position.snap = null;
    else if (['left', 'right', 'top', 'bottom'].includes(parsed.snap)) position.snap = parsed.snap;
    if (Number.isFinite(parsed.x)) position.x = Math.round(parsed.x);
    if (Number.isFinite(parsed.y)) position.y = Math.round(parsed.y);
  } catch {
    /* first run */
  }
}

function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    const bounds = win && !win.isDestroyed() ? win.getBounds() : null;
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ snap: position.snap, x: bounds ? bounds.x : position.x, y: bounds ? bounds.y : position.y }, null, 2),
    );
  } catch (error) {
    log('cannot persist window state: ' + String(error && error.message));
  }
}

function displayArea(bounds) {
  try {
    const target = bounds || (win && !win.isDestroyed() ? win.getBounds() : null);
    const display = target ? screen.getDisplayMatching(target) : screen.getPrimaryDisplay();
    return display.workArea;
  } catch {
    return { x: 0, y: 0, width: 1440, height: 900 };
  }
}

function desiredBounds() {
  const current = win && !win.isDestroyed() ? win.getBounds() : null;
  const area = displayArea(current);
  return resolveBounds(
    {
      snap: position.snap,
      anchorX: position.x !== null ? position.x : current ? current.x : area.x,
      anchorY: position.y !== null ? position.y : current ? current.y : area.y,
      width: position.width > 0 ? clamp(position.width, MIN_WIDTH, MAX_WIDTH) : 140,
      height: position.height > 0 ? Math.max(MIN_HEIGHT, position.height) : 400,
    },
    area,
  );
}

function push(channel, payload) {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* renderer gone */
  }
}

function publicState() {
  const bounds = win && !win.isDestroyed() ? win.getBounds() : null;
  return {
    snap: position.snap,
    x: bounds ? bounds.x : position.x,
    y: bounds ? bounds.y : position.y,
    width: bounds ? bounds.width : position.width,
    height: bounds ? bounds.height : position.height,
    offline: latest ? Boolean(latest.offline) : true,
  };
}

function applyBounds(animate = false) {
  if (!win || win.isDestroyed()) return;
  ignoreMovesUntil = Date.now() + 600;
  if (boundsTimer) {
    clearTimeout(boundsTimer);
    boundsTimer = null;
  }
  const desired = desiredBounds();
  const current = win.getBounds();
  const next = dragging
    ? { x: current.x, y: current.y, width: desired.width, height: desired.height }
    : desired;
  try {
    if (animate && process.platform === 'darwin') win.setBounds(next, true);
    else win.setBounds(next);
  } catch (error) {
    log('setBounds failed: ' + String(error && error.message));
  }
  push('side-dock:state', publicState());
}

function revealWindow() {
  if (pendingShow && win && !win.isDestroyed()) {
    pendingShow = false;
    if (!win.isVisible()) win.showInactive();
  }
}

function handleDrop() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const area = displayArea(bounds);
  const nearest = nearestEdge(bounds, area);
  dragging = false;
  position.x = bounds.x;
  position.y = bounds.y;
  position.snap = snapEdge(bounds, area, SNAP_THRESHOLD);
  savePrefs();
  ignoreMovesUntil = Date.now() + 600;
  applyBounds(true);
  log(`drop snap=${String(position.snap)} distance=${Math.round(nearest.distance)}`);
}

function createWindow() {
  const bounds = desiredBounds();
  win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin' ? { vibrancy: 'sidebar', visualEffectState: 'active' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* unsupported */
  }
  win.webContents.on('context-menu', (event) => event.preventDefault());
  win.webContents.setBackgroundThrottling(false);

  win.webContents.once('did-finish-load', () => {
    log('window loaded ' + JSON.stringify(win.getBounds()));
    push('side-dock:state', publicState());
    if (latest) push('side-dock:stats', latest);
    setTimeout(() => revealWindow(), 1500);
  });

  win.on('will-move', () => {
    if (!win || win.isDestroyed()) return;
    if (Date.now() < ignoreMovesUntil) return;
    dragging = true;
    position.snap = null;
  });
  win.on('move', () => {
    if (!win || win.isDestroyed()) return;
    if (Date.now() < ignoreMovesUntil) return;
    if (moveSettleTimer) clearTimeout(moveSettleTimer);
    moveSettleTimer = setTimeout(() => {
      moveSettleTimer = null;
      handleDrop();
    }, 260);
  });
  win.on('closed', () => {
    win = null;
  });

  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// -------------------------------------------------------------------- data

let loggedFirstTick = false;
async function tick(options = {}) {
  try {
    latest = { offline: false, data: await collectSnapshot(options) };
    if (!loggedFirstTick) {
      loggedFirstTick = true;
      const data = latest.data;
      log(
        'first snapshot: today=' +
          data.history.today +
          ' month=' +
          data.history.month +
          ' tokens=' +
          data.totals.total +
          ' sessions=' +
          data.sessions.length +
          ' account=' +
          data.account.status +
          ' zen=' +
          data.zen.status,
      );
    }
  } catch (error) {
    latest = { offline: true, error: error instanceof Error ? error.message : String(error) };
    log('snapshot failed: ' + latest.error);
  }
  push('side-dock:stats', latest);
  return latest;
}

// --------------------------------------------------------------------- IPC

ipcMain.handle('side-dock:init', () => ({ ...publicState() }));
ipcMain.handle('side-dock:latest', () => latest);
ipcMain.handle('side-dock:fit', (_event, size) => {
  const wantedWidth = Math.ceil(Number(size && size.width) || 0);
  const wantedHeight = Math.ceil(Number(size && size.height) || 0);
  if (wantedWidth <= 0 || wantedHeight <= 0) return publicState();
  const area = displayArea();
  position.width = clamp(wantedWidth, MIN_WIDTH, Math.min(MAX_WIDTH, area.width));
  position.height = clamp(wantedHeight, MIN_HEIGHT, area.height);
  applyBounds(false);
  revealWindow();
  return publicState();
});
ipcMain.handle('side-dock:flip', () => {
  const bounds = win && !win.isDestroyed() ? win.getBounds() : desiredBounds();
  const area = displayArea(bounds);
  position.x = bounds.x;
  position.y = bounds.y;
  if (position.snap === 'left') position.snap = 'right';
  else if (position.snap === 'right') position.snap = 'left';
  else if (position.snap === 'top') position.snap = 'bottom';
  else if (position.snap === 'bottom') position.snap = 'top';
  else {
    const leftDistance = bounds.x - area.x;
    const rightDistance = area.x + area.width - (bounds.x + bounds.width);
    position.snap = leftDistance <= rightDistance ? 'right' : 'left';
  }
  savePrefs();
  applyBounds(true);
  return publicState();
});
ipcMain.handle('side-dock:refresh', () => {
  void tick();
  return true;
});
ipcMain.on('side-dock:renderer-log', (_event, message) => {
  log('renderer: ' + String(message));
});
ipcMain.handle('side-dock:close', () => {
  app.quit();
  return true;
});
// Compatibility no-ops kept for older renderers.
ipcMain.handle('side-dock:set-collapsed', () => publicState());
ipcMain.handle('side-dock:set-width', () => publicState());
ipcMain.handle('side-dock:set-height', () => publicState());

// -------------------------------------------------------------------- boot

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });

  app.whenReady().then(async () => {
    if (DUMP_MODE) {
      const snapshot = await collectSnapshot({ awaitInitial: true });
      process.stdout.write(JSON.stringify(snapshot) + '\n');
      app.quit();
      return;
    }

    loadPrefs();
    createWindow();
    // The initial placement emits move events; do not treat them as a drag drop.
    ignoreMovesUntil = Date.now() + 1500;
    screen.on('display-metrics-changed', () => applyBounds(false));
    screen.on('display-added', () => applyBounds(false));
    screen.on('display-removed', () => applyBounds(false));

    await tick({ awaitInitial: true });
    pollTimer = setInterval(() => void tick(), POLL_MS);
  });

  app.on('activate', () => {
    if (!win || win.isDestroyed()) createWindow();
    else if (!win.isVisible()) win.showInactive();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (boundsTimer) clearTimeout(boundsTimer);
    if (moveSettleTimer) clearTimeout(moveSettleTimer);
  });
}
