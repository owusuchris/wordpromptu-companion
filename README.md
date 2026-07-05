# Wordpromptu Companion v3

Desktop helper app for Wordpromptu. Detects and projects to multiple external screens connected to your computer.

## How It Works

1. Run this app on the **same computer** where your screens/projectors are connected.
2. Open the Wordpromptu web app (on Replit) **in a browser on that same computer**.
3. The web app connects to this companion via WebSocket on `ws://localhost:8765`.
4. Use the companion's Settings window to open a projector on any detected screen.

> **Why same computer?** The companion runs a local WebSocket server (`localhost:8765`).  
> The browser must be on the same machine to reach it. The Wordpromptu site on Replit  
> sends commands through the browser — so the user running the app and operating the  
> projector screens must be at the same machine.

## Quick Start (Development)

```bash
# Install dependencies (Node.js 18+ required)
npm install

# Run in development mode
npm start
```

The app starts as a system tray icon. Double-click the tray icon (or it opens Settings on first launch).

## Build Installers

```bash
# Current platform only
npm run dist

# Specific platform
npm run dist:win    # → dist/*.exe  (Windows NSIS installer)
npm run dist:mac    # → dist/*.dmg  (macOS disk image)
npm run dist:linux  # → dist/*.deb + dist/*.AppImage
```

### Cross-Platform Builds via GitHub Actions

Push a tag (`v3.0.0`) or trigger the workflow manually — GitHub Actions builds all three platforms natively and uploads the installers as artifacts.

```bash
git tag v3.0.0
git push origin v3.0.0
```

## Icons

Replace the placeholder `assets/icon.png` (16×16) with proper icons before distribution:

| File | Size | Platform |
|------|------|----------|
| `assets/icon.ico` | 256×256 | Windows |
| `assets/icon.icns` | 512×512 | macOS |
| `assets/icon.png` | 512×512 | Linux |

Free tool to convert: [icoconvert.com](https://icoconvert.com) / [cloudconvert.com](https://cloudconvert.com)

## File Structure

```
companion-v3/
  main.js          ← Electron main process: WS server + window manager
  preload.js       ← IPC bridge between main and renderer windows
  projector.html   ← Fullscreen display window (verse, image, video)
  settings.html    ← Settings UI: screen list, open/close projectors
  assets/
    icon.png / .ico / .icns
  .github/workflows/build.yml   ← CI matrix build
  package.json
```

## WebSocket Protocol (port 8765)

The companion acts as the **server**. Wordpromptu connects to it.

### Companion → Wordpromptu (on connect)
```json
{ "type": "hello", "version": "3.0", "features": ["multi_screen", ...] }
{ "type": "screens", "screens": [ { "index": 0, "name": "Screen 1 (Primary)", "width": 1920, "height": 1080, "x": 0, "y": 0, "is_primary": true } ] }
```

### Wordpromptu → Companion (commands)
| type | action |
|------|--------|
| `get_screens` | Re-send screen list |
| `identify_screens` | Flash number on each screen for 5s |
| `open_projector` + `screen_index` | Open projector on that screen |
| `update_verse` + `content` (HTML) | Display verse |
| `clear_projector` | Clear verse text only — persistent background stays visible |
| `close_projector` | Close projector window |
| `style_update` + `style` object | Change font/colors |
| `image_display` + `image_url` | Show image fullscreen |
| `video_display` + `video_url` | Open video in browser |
| `clear_media` | Return to verse display |
| `ping` | Keepalive — companion replies `pong` |
