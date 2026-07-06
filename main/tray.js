// System tray icon and menu.
const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');
const windows = require('./windows');
const settings = require('./settings');

let tray = null;

function create() {
  if (tray) return tray;
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('PieFlow: hold your hotkey and speak');
  refreshMenu();
  tray.on('double-click', () => windows.createDashboard());
  return tray;
}

function refreshMenu() {
  if (!tray) return;
  const cfg = settings.load();
  const menu = Menu.buildFromTemplate([
    { label: 'Open PieFlow', click: () => windows.createDashboard() },
    { type: 'separator' },
    { label: `Dictate: hold ${cfg.hotkey ? cfg.hotkey.label : '...'}`, enabled: false },
    { label: `Command: hold ${cfg.commandHotkey ? cfg.commandHotkey.label : '...'}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Launch at startup',
      type: 'checkbox',
      checked: !!cfg.launchAtStartup,
      click: (item) => {
        settings.save({ launchAtStartup: item.checked });
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit PieFlow',
      click: () => {
        app.isQuittingForReal = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

module.exports = { create, refreshMenu };
