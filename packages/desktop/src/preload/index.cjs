const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer gets a narrow, explicitly enumerated API. Nothing generic like
 * `ipcRenderer.send(channel, ...)` is exposed, so a compromised renderer cannot
 * reach arbitrary main-process handlers.
 */

const invoke = {
  getStatus: () => ipcRenderer.invoke('orbit:get-status'),
  getPrefs: () => ipcRenderer.invoke('orbit:get-prefs'),
  setPrefs: (patch) => ipcRenderer.invoke('orbit:set-prefs', patch),
  requestSources: (options) => ipcRenderer.invoke('orbit:request-sources', options),
  grantCapture: (sourceId) => ipcRenderer.invoke('orbit:grant-capture', sourceId),
  registerCastPanel: (panelId, hwnd) => ipcRenderer.invoke('orbit:register-cast-panel', panelId, hwnd),
  startSession: (catalog) => ipcRenderer.invoke('orbit:start-session', catalog),
  stopSession: () => ipcRenderer.invoke('orbit:stop-session'),
  setActiveSource: (sourceId) => ipcRenderer.invoke('orbit:set-active-source', sourceId),
  pushWorkspace: (state) => ipcRenderer.invoke('orbit:push-workspace', state),
  offer: (panelId, sdp) => ipcRenderer.invoke('orbit:offer', panelId, sdp),
  ice: (panelId, candidate) => ipcRenderer.invoke('orbit:ice', panelId, candidate),
  streamStop: (panelId) => ipcRenderer.invoke('orbit:stream-stop', panelId),
  pushPointer: (pointer, phase) => ipcRenderer.invoke('orbit:push-pointer', pointer, phase),
  revoke: (receiverId) => ipcRenderer.invoke('orbit:revoke', receiverId),
  newPairingCode: () => ipcRenderer.invoke('orbit:new-pairing-code'),
  pushTask: (task) => ipcRenderer.invoke('orbit:push-task', task),
  pushApproval: (approval) => ipcRenderer.invoke('orbit:push-approval', approval),
  pushTranscript: (transcript) => ipcRenderer.invoke('orbit:push-transcript', transcript),
  pushVoiceState: (state) => ipcRenderer.invoke('orbit:push-voice-state', state),
  openReceiverPage: () => ipcRenderer.invoke('orbit:open-receiver-page'),
  openLogFolder: () => ipcRenderer.invoke('orbit:open-log-folder'),
  renderQr: (payload) => ipcRenderer.invoke('orbit:render-qr', payload),
  gestureStart: () => ipcRenderer.invoke('orbit:gesture-start'),
  gestureRestart: () => ipcRenderer.invoke('orbit:gesture-restart'),
  gestureStop: () => ipcRenderer.invoke('orbit:gesture-stop'),
  gestureArm: () => ipcRenderer.invoke('orbit:gesture-arm'),
  gestureDisarm: () => ipcRenderer.invoke('orbit:gesture-disarm'),
  gestureCalibrate: () => ipcRenderer.invoke('orbit:gesture-calibrate'),
  gestureGazeCalibrate: (target) => ipcRenderer.invoke('orbit:gesture-gaze-calibrate', target),
  gestureState: () => ipcRenderer.invoke('orbit:gesture-state'),
};

/** Event channels are fixed at build time; the renderer cannot subscribe to others. */
const EVENTS = [
  'orbit:ev-status',
  'orbit:ev-sources',
  'orbit:ev-workspace',
  'orbit:ev-panel-select',
  'orbit:ev-panel-close',
  'orbit:ev-panel-return',
  'orbit:ev-panel-move',
  'orbit:ev-mode-set',
  'orbit:ev-command',
  'orbit:ev-stop',
  'orbit:ev-approval-response',
  'orbit:ev-pairing',
  'orbit:ev-answer',
  'orbit:ev-ice-remote',
  'orbit:ev-error',
  'orbit:ev-gesture-status',
  'orbit:ev-gesture-event',
  'orbit:ev-grab-target',
  'orbit:register-cast-panel',
  'orbit:ev-cycle-panel',
  'orbit:ev-gesture-state',
];

function subscribe(channel, listener) {
  if (!EVENTS.includes(channel)) throw new Error('Unknown channel');
  // Strip the Electron event object; the renderer only receives payloads.
  const wrapped = (_event, ...args) => listener(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('orbit', { invoke, subscribe });
