# Markdown Editor

A modern desktop markdown editor built with Angular and Electron. Provides a professional editing experience with multi-pane editor groups, tabs, multiple view modes, advanced search with replace, resizable split panes, and full session restore.

![Markdown Editor](src/assets/demo.gif)

## Features

### Editor Groups (Multi-Pane)
- Open two independent editor panes side-by-side, each with its own tab bar and view mode
- **Move to right pane** — hover a tab and click the `→` button to move it to a new or existing right pane (button only appears when the left group has more than one tab)
- **Move to left pane** — hover a tab in the right pane and click the `←` button to move it back
- Each pane can independently be in Preview, Edit, or Split mode
- Drag the divider between the two panes to resize them
- The right pane closes automatically when its last tab is moved or closed
- Both groups and their open tabs are restored on next launch

### Tabs
- **Single-click** a file to open it in a preview tab (italicized title)
- **Double-click** to promote it to a permanent tab
- Middle-click or the × button to close a tab
- Dirty state indicator (●) when a file has unsaved changes
- `Ctrl+W` closes the active tab
- All open tabs are restored on next launch, with the previously active tab re-selected

### View Modes
- **Preview** — rendered markdown output (default on first launch)
- **Edit** — focused plain-text editor with line numbers and search highlighting
- **Split** — side-by-side editor and preview with synchronized scrolling and a draggable resizable divider
- View mode is set per pane — the toolbar always reflects the currently focused pane

### Font Size
- `Ctrl+Scroll` anywhere in the app to increase or decrease the editor and preview font size
- Current size is shown in the status bar (e.g. `13px`); click it to reset to the default
- Font size is saved and restored across sessions

### File Explorer
- Multi-root workspace: add multiple folders, each shown as a collapsible tree
- Single-click opens a file; double-click opens it in a new permanent tab
- Active tab's file is automatically highlighted and its parent folders expanded in the explorer
- Rename (F2), delete, and create new files/folders inline
- New File / New Folder buttons appear in the explorer header when exactly one workspace is open
- Recent files section with a hover-reveal × button to clear the entire list

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

### Session & Window Persistence
- Workspace roots, editor groups, all open tabs, active tab, per-pane view modes, split divider positions, font size, and recent files are all restored on next launch
- Window position and size are saved on close and restored on the next launch

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
| `Ctrl+Scroll` | Increase / decrease font size |
| `F2` | Rename selected file (explorer focused) |
| `Delete` | Delete selected file (explorer focused) |

## License

MIT
