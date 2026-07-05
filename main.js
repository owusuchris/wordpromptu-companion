'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron')
const WebSocket = require('ws')
const path = require('path')
const fs = require('fs')

const WS_PORT = 8765
const COMPANION_VERSION = '3.0'
const FEATURES = ['multi_screen', 'lazy_open_projector', 'video_via_browser', 'screen_index', 'go_build', 'open_display_url']
const PREFS_FILE = path.join(app.getPath('userData'), 'preferences.json')

let tray = null
let settingsWin = null
let wsServer = null
let wsClient = null

// Map of screenIndex -> BrowserWindow (projector windows)
const projectorWindows = new Map()

// Map of screenIndex -> BrowserWindow (secondary display windows — load remote URLs via SSE)
const displayWindows = new Map()

// Merged style snapshot from the operator panel. style_update messages are
// incremental (a font change carries no bgUrl; a clear sends only
// { bgImage:false }), so we merge them into a full snapshot and replay that to
// any projector opened later (windows are lazy-opened). Storing just the last
// message would lose the background whenever the last change was font-only.
let styleSnapshot = null

function mergeStyleSnapshot(s) {
  if (!s) return
  if (!styleSnapshot) styleSnapshot = {}
  for (const k of ['bgColor', 'bgMediaType', 'fontColor', 'fontFamily', 'fontSize']) {
    if (s[k] !== undefined) styleSnapshot[k] = s[k]
  }
  if (s.bgImage !== undefined) {
    styleSnapshot.bgImage = s.bgImage
    if (s.bgImage === false) delete styleSnapshot.bgUrl
  }
  // Only update bgUrl when explicitly provided — never drop it just because a
  // message omitted it (it is cleared above when bgImage:false arrives).
  if (s.bgUrl !== undefined && s.bgUrl !== '') styleSnapshot.bgUrl = s.bgUrl
}

// ── Preferences ────────────────────────────────────────────────────────────
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) } catch { return {} }
}
function savePrefs(data) {
  fs.writeFileSync(PREFS_FILE, JSON.stringify(data, null, 2))
}

// ── Screen helpers ──────────────────────────────────────────────────────────
function getScreenList() {
  const primary = screen.getPrimaryDisplay()
  return screen.getAllDisplays().map((d, i) => ({
    index:      i,
    name:       `Screen ${i + 1}${d.id === primary.id ? ' (Primary)' : ''}`,
    width:      d.bounds.width,
    height:     d.bounds.height,
    x:          d.bounds.x,
    y:          d.bounds.y,
    is_primary: d.id === primary.id,
  }))
}

function sendToClient(msg) {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify(msg))
  }
}

// ── Projector window ────────────────────────────────────────────────────────
function openProjector(screenIndex) {
  const displays = screen.getAllDisplays()
  const display  = displays[screenIndex] ?? screen.getPrimaryDisplay()
  const { x, y, width, height } = display.bounds

  if (projectorWindows.has(screenIndex)) {
    const existing = projectorWindows.get(screenIndex)
    if (!existing.isDestroyed()) {
      existing.focus()
      sendToClient({ type: 'projector_opened', screen_index: screenIndex })
      return
    }
  }

  const win = new BrowserWindow({
    x, y, width, height,
    frame:           false,
    fullscreen:      true,
    alwaysOnTop:     true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.loadFile('projector.html')
  projectorWindows.set(screenIndex, win)

  win.on('closed', () => {
    projectorWindows.delete(screenIndex)
    notifySettingsWin()
  })

  win.webContents.once('did-finish-load', () => {
    // Apply the merged style so a lazily-opened projector shows the correct
    // background/fonts immediately, not just after the next change.
    if (styleSnapshot) win.webContents.send('style-update', styleSnapshot)
    sendToClient({ type: 'projector_opened', screen_index: screenIndex })
    notifySettingsWin()
  })
}

function sendToAllProjectors(channel, payload) {
  projectorWindows.forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

function sendToProjector(screenIndex, channel, payload) {
  if (screenIndex === undefined || screenIndex === null) {
    sendToAllProjectors(channel, payload)
  } else {
    const win = projectorWindows.get(screenIndex)
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function closeAllProjectors() {
  projectorWindows.forEach((win) => { if (!win.isDestroyed()) win.close() })
  projectorWindows.clear()
}

// ── URL validation ───────────────────────────────────────────────────────────
// Only http/https may be handed to shell.openExternal() or loaded into a
// BrowserWindow from a WS message. Without this, any local process or web
// page that connects to the (unauthenticated, localhost-only) WS server
// could hand us a custom URL scheme — some registered protocol handlers on
// Windows/macOS can be abused for unexpected side effects — or a
// file:/data: URL to load arbitrary local content into a fullscreen window.
function isSafeUrl(url) {
  if (typeof url !== 'string' || !url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

// ── Secondary display windows (load Wordpromptu display.html via SSE) ──────
function openDisplayUrl(screenIndex, url) {
  if (!isSafeUrl(url)) return
  const displays = screen.getAllDisplays()
  const display  = displays[screenIndex] ?? screen.getPrimaryDisplay()
  const { x, y, width, height } = display.bounds

  // Replace any existing display on this screen
  if (displayWindows.has(screenIndex)) {
    const existing = displayWindows.get(screenIndex)
    if (!existing.isDestroyed()) existing.close()
  }

  const win = new BrowserWindow({
    x, y, width, height,
    frame:           false,
    fullscreen:      true,
    alwaysOnTop:     true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  win.loadURL(url)
  displayWindows.set(screenIndex, win)

  win.on('closed', () => {
    displayWindows.delete(screenIndex)
    notifySettingsWin()
  })

  win.webContents.once('did-finish-load', () => {
    sendToClient({ type: 'display_opened', screen_index: screenIndex })
    notifySettingsWin()
  })
}

function closeAllDisplayWindows() {
  displayWindows.forEach((win) => { if (!win.isDestroyed()) win.close() })
  displayWindows.clear()
}

// ── Screen identification (flash overlay) ──────────────────────────────────
function identifyScreens() {
  screen.getAllDisplays().forEach((d, i) => {
    const win = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y,
      width: d.bounds.width, height: d.bounds.height,
      frame: false, alwaysOnTop: true, transparent: true, focusable: false,
      webPreferences: { contextIsolation: true },
    })
    win.loadURL(`data:text/html,
      <body style="margin:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center">
        <div style="color:#fff;font-size:200px;font-family:sans-serif;font-weight:bold">${i + 1}</div>
      </body>`)
    setTimeout(() => { if (!win.isDestroyed()) win.close() }, 5000)
  })
}

// ── Settings window ─────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 600, height: 500, minWidth: 480, minHeight: 400,
    title: 'Wordpromptu Companion',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  settingsWin.loadFile('settings.html')
  settingsWin.on('closed', () => { settingsWin = null })
}

function notifySettingsWin() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('state-update', {
      screens:    getScreenList(),
      connected:  wsClient !== null && wsClient.readyState === WebSocket.OPEN,
      projectors: Array.from(projectorWindows.keys()),
      displays:   Array.from(displayWindows.entries()).map(([idx, win]) => ({
        screen_index: idx,
        url: win.isDestroyed() ? '' : win.webContents.getURL(),
      })),
    })
  }
}

// ── IPC from renderer ───────────────────────────────────────────────────────
ipcMain.handle('get-state', () => ({
  screens:    getScreenList(),
  connected:  wsClient !== null && wsClient.readyState === WebSocket.OPEN,
  projectors: Array.from(projectorWindows.keys()),
  displays:   Array.from(displayWindows.entries()).map(([idx, win]) => ({
    screen_index: idx,
    url: win.isDestroyed() ? '' : win.webContents.getURL(),
  })),
  wsPort:     WS_PORT,
}))

ipcMain.on('open-projector', (_, idx) => openProjector(idx))
ipcMain.on('close-projector', (_, idx) => {
  if (idx === undefined) { closeAllProjectors(); return }
  const win = projectorWindows.get(idx)
  if (win && !win.isDestroyed()) win.close()
})
ipcMain.on('identify-screens', () => identifyScreens())
ipcMain.on('close-display', (_, idx) => {
  if (idx === undefined) { closeAllDisplayWindows(); return }
  const win = displayWindows.get(idx)
  if (win && !win.isDestroyed()) win.close()
})

// ── WebSocket server ────────────────────────────────────────────────────────
function startWebSocketServer() {
  // Bind explicitly to loopback. Without a `host`, the `ws` library binds to
  // all interfaces (0.0.0.0), which would expose this unauthenticated control
  // channel to anything on the local network, not just this machine.
  wsServer = new WebSocket.Server({ port: WS_PORT, host: '127.0.0.1' })

  wsServer.on('listening', () => {
    console.log(`WS server listening on port ${WS_PORT}`)
    notifySettingsWin()
  })

  wsServer.on('connection', (ws) => {
    // Only one client at a time
    if (wsClient && wsClient.readyState === WebSocket.OPEN) wsClient.terminate()
    wsClient = ws
    notifySettingsWin()

    // Greet immediately
    ws.send(JSON.stringify({ type: 'hello', version: COMPANION_VERSION, features: FEATURES }))
    ws.send(JSON.stringify({ type: 'screens', screens: getScreenList() }))

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      handleMessage(msg, ws)
    })

    ws.on('close', () => {
      wsClient = null
      notifySettingsWin()
    })
  })

  // Push screen list when monitors change
  screen.on('display-added',   () => sendToClient({ type: 'screens', screens: getScreenList() }))
  screen.on('display-removed', () => sendToClient({ type: 'screens', screens: getScreenList() }))
}

function handleMessage(msg, ws) {
  const reply = (obj) => ws.send(JSON.stringify(obj))

  switch (msg.type) {
    case 'ping':
      reply({ type: 'pong' })
      break

    case 'get_screens':
      reply({ type: 'screens', screens: getScreenList() })
      break

    case 'identify_screens':
      identifyScreens()
      reply({ type: 'ok' })
      break

    case 'open_projector':
      openProjector(msg.screen_index ?? 0)
      // projector_opened is sent after window loads
      break

    case 'update_verse':
      sendToProjector(msg.screen_index, 'update-verse', { content: msg.content, reference: msg.reference })
      reply({ type: 'ok' })
      break

    case 'clear_projector':
      sendToAllProjectors('clear-projector', {})
      reply({ type: 'ok' })
      break

    case 'close_projector':
      if (msg.screen_index !== undefined) {
        const win = projectorWindows.get(msg.screen_index)
        if (win && !win.isDestroyed()) win.close()
      } else {
        closeAllProjectors()
      }
      reply({ type: 'ok' })
      break

    case 'style_update':
      mergeStyleSnapshot(msg.style)
      sendToAllProjectors('style-update', msg.style)
      reply({ type: 'ok' })
      break

    case 'image_display':
      sendToProjector(msg.screen_index, 'image-display', { url: msg.image_url })
      reply({ type: 'ok' })
      break

    case 'video_display':
      // Open in default browser — same behaviour as Go companion
      if (isSafeUrl(msg.video_url)) {
        require('electron').shell.openExternal(msg.video_url)
      }
      reply({ type: 'ok' })
      break

    case 'clear_media':
      sendToAllProjectors('clear-media', {})
      reply({ type: 'ok' })
      break

    case 'open_display_url':
      openDisplayUrl(msg.screen_index ?? 0, msg.url)
      reply({ type: 'ok' })
      break

    case 'close_display_url':
      if (msg.screen_index !== undefined) {
        const dwin = displayWindows.get(msg.screen_index)
        if (dwin && !dwin.isDestroyed()) dwin.close()
      } else {
        closeAllDisplayWindows()
      }
      reply({ type: 'ok' })
      break

    default:
      reply({ type: 'ok' })
  }
}

// ── Tray ────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png')
  const img = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty()

  tray = new Tray(img)
  tray.setToolTip('Wordpromptu Companion')
  tray.on('double-click', openSettings)

  const menu = Menu.buildFromTemplate([
    { label: 'Open Settings', click: openSettings },
    { type: 'separator' },
    { label: 'Close All Projectors', click: closeAllProjectors },
    { label: 'Close All Display Windows', click: closeAllDisplayWindows },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Keep running when all windows are closed (tray app)
  app.on('window-all-closed', (e) => e.preventDefault())

  createTray()
  startWebSocketServer()
  openSettings()
})

app.on('before-quit', () => {
  closeAllProjectors()
  closeAllDisplayWindows()
  if (wsServer) wsServer.close()
})
