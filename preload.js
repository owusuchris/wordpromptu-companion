'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('companion', {
  // Settings window
  getState:        ()    => ipcRenderer.invoke('get-state'),
  openProjector:   (idx) => ipcRenderer.send('open-projector', idx),
  closeProjector:  (idx) => ipcRenderer.send('close-projector', idx),
  closeDisplay:    (idx) => ipcRenderer.send('close-display', idx),
  identifyScreens: ()    => ipcRenderer.send('identify-screens'),
  onStateUpdate:   (fn)  => ipcRenderer.on('state-update', (_, data) => fn(data)),

  // Projector window
  onUpdateVerse:  (fn) => ipcRenderer.on('update-verse',  (_, d) => fn(d)),
  onClearProjector:(fn)=> ipcRenderer.on('clear-projector',(_, d) => fn(d)),
  onStyleUpdate:  (fn) => ipcRenderer.on('style-update',  (_, d) => fn(d)),
  onImageDisplay: (fn) => ipcRenderer.on('image-display', (_, d) => fn(d)),
  onClearMedia:   (fn) => ipcRenderer.on('clear-media',   (_, d) => fn(d)),
})
