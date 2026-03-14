import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { DesktopApi } from '../../shared/types.js';

const api: DesktopApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (input) => ipcRenderer.invoke('settings:save', input),
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
  },
  documents: {
    list: () => ipcRenderer.invoke('documents:list'),
    pick: () => ipcRenderer.invoke('documents:pick'),
    add: (paths) => ipcRenderer.invoke('documents:add', paths),
    clear: () => ipcRenderer.invoke('documents:clear'),
    analyze: (request) => ipcRenderer.invoke('documents:analyze', request),
    retry: (request) => ipcRenderer.invoke('documents:retry', request),
    rename: (request) => ipcRenderer.invoke('documents:rename', request),
    skip: (request) => ipcRenderer.invoke('documents:skip', request),
    updateProposedName: (request) => ipcRenderer.invoke('documents:update-proposed-name', request),
    open: (key) => ipcRenderer.invoke('documents:open', key),
    reveal: (key) => ipcRenderer.invoke('documents:reveal', key),
  },
  app: {
    getDiagnostics: () => ipcRenderer.invoke('app:get-diagnostics'),
    getPathForFile: (file) => webUtils.getPathForFile(file),
  },
};

contextBridge.exposeInMainWorld('desktopApi', api);
