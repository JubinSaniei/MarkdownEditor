# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm start                    # Angular dev server (http://localhost:4200)
npm run electron-dev         # Angular + Electron together (waits for port 4200)
npm run electron-dev:4201    # Same but on port 4201

# Build & Package
npm run build                # Angular production build to dist/
npm run build-electron       # Production build + electron-builder package
npm run dist                 # build + electron-builder (no publish)

# Electron only (requires built dist/ already)
npm run electron             # Launch Electron against existing build
```

No test runner is configured in this project.

## Architecture

This is an **Angular + Electron** desktop markdown editor. Angular runs as the renderer process; Electron provides the native shell and file system access.

### Electron / Angular Bridge

- `public/electron.js` — Main Electron process. Registers IPC handlers for all file operations and dialogs. In dev mode it auto-detects the Angular dev server on ports 4200–4205.
- `public/preload.js` — Exposes a safe `window.electron` API to the renderer via `contextBridge`. Node integration is disabled; all native access goes through this bridge.
- `src/app/services/electron.service.ts` — Angular service that wraps `window.electron` IPC calls, used by components and other services.

### Service Layer

| Service | Responsibility |
|---|---|
| `FileService` | File read/write/delete, directory tree with 60-second cache, markdown-only filtering |
| `ThemeService` | Light/dark theme via BehaviorSubject, persisted in localStorage, respects system preference |
| `SearchService` | Global search state (query, results, current index) shared across components |
| `ScrollSyncService` | Synchronizes scroll position between editor and preview panes in split mode |

### Component Structure

- **`AppComponent`** — Root orchestrator. Owns view mode state (preview / edit / split), keyboard shortcuts (Ctrl+S, Ctrl+F), workspace persistence via localStorage, and wires services together.
- **`FileExplorerComponent`** — Sidebar showing workspace files grouped by folder.
- **`MarkdownEditorComponent`** — Plain-text editor with search result highlighting.
- **`MarkdownPreviewComponent`** — Rendered HTML preview using `marked` (GFM) + `highlight.js` for code blocks.

### Build Output

- `dist/` — Angular production build (consumed by Electron)
- `dist-electron/` — Packaged app: Windows portable `.exe` + NSIS installer, macOS `.dmg`, Linux `.AppImage`

### Key Conventions

- Styles are SCSS; global styles in `src/styles.scss`, component styles co-located.
- TypeScript strict mode is enabled (`tsconfig.json`).
- State is managed with RxJS `BehaviorSubject`s in services; no NgRx.
- Electron app ID: `com.example.markdowneditor`; icons in `src/assets/`.
