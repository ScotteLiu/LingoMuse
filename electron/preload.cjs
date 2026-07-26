const { contextBridge, ipcRenderer } = require('electron')

const on = (channel, listener) => {
  const wrapped = (_event, payload) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('lingomuse', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  listHistory: () => ipcRenderer.invoke('history:list'),
  addHistory: (entry) => ipcRenderer.invoke('history:add', entry),
  importHistory: (entries) => ipcRenderer.invoke('history:import', entries),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  translate: (text, requestId) => ipcRenderer.invoke('translation:run', { text, requestId }),
  cancelTranslation: () => ipcRenderer.invoke('translation:cancel'),
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),
  restartOfflineEngine: () => ipcRenderer.invoke('engine:restart-offline'),
  pullModel: (model) => ipcRenderer.invoke('engine:pull', model),
  openOllamaDownload: () => ipcRenderer.invoke('engine:download'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  popupReady: () => ipcRenderer.invoke('popup:ready'),
  closePopup: () => ipcRenderer.invoke('popup:close'),
  openMainFromPopup: (payload) => ipcRenderer.invoke('popup:open-main', payload),
  setPopupHeight: (height) => ipcRenderer.invoke('popup:set-height', height),
  startPopupResize: (payload) => ipcRenderer.invoke('popup:resize-start', payload),
  movePopupResize: (payload) => ipcRenderer.invoke('popup:resize-move', payload),
  endPopupResize: () => ipcRenderer.invoke('popup:resize-end'),
  setPopupPinned: (pinned) => ipcRenderer.invoke('popup:set-pinned', pinned),
  setPopupOpacity: (opacity, persist = false) => ipcRenderer.invoke('popup:set-opacity', opacity, persist),
  markPerfStage: (stage) => ipcRenderer.invoke('perf:mark', stage),
  onClipboardTrigger: (listener) => on('clipboard:trigger', listener),
  onPopupResult: (listener) => on('popup:result', listener),
  onHookStatus: (listener) => on('hook:status', listener),
  onSettingsChanged: (listener) => on('settings:changed', listener),
  onSettingsPersistence: (listener) => on('settings:persistence', listener),
  onHistoryChanged: (listener) => on('history:changed', listener),
  onModelProgress: (listener) => on('engine:pull-progress', listener),
  onTranslationPartial: (listener) => on('translation:partial', listener),
  onEngineState: (listener) => on('engine:state', listener),
})
