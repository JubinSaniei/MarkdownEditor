# Markdown Editor

A modern desktop markdown editor built with Angular and Electron. Provides a professional editing experience with tabs, multiple view modes, advanced search with replace, and resizable split panes.

![Markdown Editor](src/assets/demo.gif)

## Features

### Tabs
- **Single-click** a file to open it in a preview tab (italicized title)
- **Double-click** to promote it to a permanent tab
- Middle-click or the × button to close a tab
- Dirty state indicator (●) when a file has unsaved changes
- `Ctrl+W` closes the active tab

### View Modes
- **Preview** — rendered markdown output
- **Edit** — focused plain-text editor with line numbers and search highlighting
- **Split** — side-by-side editor and preview with synchronized scrolling and a draggable resizable divider

### File Explorer
- Multi-root workspace: add multiple folders, each shown as a collapsible tree
- Single-click opens a file; double-click opens it in a new permanent tab
- Active tab's file is automatically highlighted and its parent folders expanded in the explorer
- Rename (F2), delete, and create new files/folders inline
- Recent files section at the top of the explorer

### Search & Replace
- `Ctrl+F` opens the search bar; `Escape` or × closes it
- Case-sensitive, whole-word, and regex search options
- `F3` / `Shift+F3` or `Enter` / `Shift+Enter` to navigate results
- Match counter (current/total)
- Visual highlighting in both editor and preview panes simultaneously in split mode
- Replace and Replace All support (edit/split modes)

### File Operations
- `Ctrl+S` — Save; Save As via the save dropdown
- `Ctrl+N` — New untitled file
- Auto-save (toggleable) with a "Saved" flash indicator
- External change detection with reload/dismiss prompt

### Workspace Persistence
- Workspace roots, open tabs, active tab, view mode, split divider position, and recent files are all restored on next launch

### Theming
- Light and dark themes via a single toggle button
- Preference persisted in localStorage

## Technology Stack

- **Frontend**: Angular 20+ with TypeScript
- **Desktop**: Electron (cross-platform)
- **Markdown**: Marked v16+ (GitHub Flavored Markdown) + highlight.js for code blocks
- **Styling**: SCSS with CSS custom properties design system
- **Editor font**: JetBrains Mono / Fira Code

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
npm install
```

### Development

```bash
# Angular dev server only (http://localhost:4200)
npm start

# Angular + Electron together
npm run electron-dev
```

### Building for Production

```bash
# Angular production build → dist/
npm run build

# Build + electron-builder package → dist-electron/
npm run dist
```

#### Output artifacts (Windows)

- `MarkdownEditor-Setup.exe` — NSIS installer
- `MarkdownEditor-Portable.exe` — portable executable
- `win-unpacked/` — unpacked app directory

To add macOS or Linux targets, edit the `build` section in `package.json`.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+N` | New file |
| `Ctrl+W` | Close active tab |
| `Ctrl+F` | Open/toggle search |
| `F3` | Next result |
| `Shift+F3` | Previous result |
| `Escape` | Close search |
| `Ctrl+1` | Preview mode |
| `Ctrl+2` | Edit mode |
| `Ctrl+3` | Split mode |
| `F2` | Rename selected file (explorer focused) |
| `Delete` | Delete selected file (explorer focused) |

## License

MIT
