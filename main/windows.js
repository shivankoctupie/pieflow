// Window management: dashboard (main UI) and overlay (recorder pill).
// The overlay window also owns microphone capture so audio works while the
// dashboard is closed.
const { BrowserWindow, screen, app } = require('electron');
const path = require('path');

let dashboard = null;
let overlay = null;

const OVERLAY_W = 320;
const OVERLAY_H = 88;

function createDashboard() {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.show();
    dashboard.focus();
    return dashboard;
  }
  dashboard = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    title: 'PieFlow',
    backgroundColor: '#f7f6f3',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'dashboard.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboard.loadFile(path.join(__dirname, '..', 'renderer', 'dashboard', 'index.html'));
  dashboard.on('close', (e) => {
    // hide to tray instead of quitting
    if (!app.isQuittingForReal) {
      e.preventDefault();
      dashboard.hide();
    }
  });
  return dashboard;
}

function overlayPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_W) / 2),
    y: Math.round(workArea.y + workArea.height - OVERLAY_H - 24),
  };
}

function createOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const pos = overlayPosition();
  overlay = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // audio capture must not be throttled while hidden
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'overlay.html'));
  return overlay;
}

function showOverlay() {
  if (!overlay || overlay.isDestroyed()) createOverlay();
  const pos = overlayPosition();
  overlay.setPosition(pos.x, pos.y);
  overlay.showInactive();
}

function hideOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.hide();
}

function getDashboard() { return dashboard && !dashboard.isDestroyed() ? dashboard : null; }
function getOverlay() { return overlay && !overlay.isDestroyed() ? overlay : null; }

module.exports = { createDashboard, createOverlay, showOverlay, hideOverlay, getDashboard, getOverlay };
