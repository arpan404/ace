// Loaded into the app's main process ahead of ace (NODE_OPTIONS=--require, e2e only). Records
// what ace hands Electron, so a test can check it and drive ace's own callbacks:
// - every caption-button overlay change (`setTitleBarOverlay`),
// - the toast activation handler (`Notification.handleActivation`),
// - the AppUserModelID toasts are filed under.
const { app, BrowserWindow, Notification } = require("electron");

const probes = { overlays: [], activation: undefined, appUserModelId: undefined };
globalThis.__aceProbes = probes;

const handleActivation = Notification.handleActivation;
Notification.handleActivation = function (callback) {
  probes.activation = callback;
  return handleActivation.call(this, callback);
};

const setAppUserModelId = app.setAppUserModelId;
app.setAppUserModelId = function (id) {
  probes.appUserModelId = id;
  return setAppUserModelId.call(this, id);
};

const setTitleBarOverlay = BrowserWindow.prototype.setTitleBarOverlay;
BrowserWindow.prototype.setTitleBarOverlay = function (options) {
  probes.overlays.push({ ...options });
  return setTitleBarOverlay.call(this, options);
};
