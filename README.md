# Markdown Editor

A modern desktop markdown editor built with Angular and Electron. Provides a professional editing experience with multi-pane editor groups, tabs, multiple view modes, advanced search with replace, resizable split panes, full session restore, and multi-provider AI assistance.

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
- **Reorder tabs** — drag a tab left or right within the same pane to reposition it; a drop indicator shows the insertion point before or after each tab

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
- Recent files section with a hover-reveal × button to clear the entire list
- **Search files** — click the 🔍 button in the explorer header to enter search mode; type to filter markdown files across all workspace folders recursively; results show filename and parent path; click a result to open it; press `Escape` or click × to return to the file tree
- **Live file system sync** — the explorer automatically detects files and folders added, removed, or renamed from outside the application (e.g. via the OS file manager, terminal, or another app); only currently expanded folders are re-queried, so the tree updates in place without collapsing

#### Virtual Workspaces

Virtual workspaces let you group any combination of existing folders and files under a single custom-named section — without moving anything on disk. This is useful when a project contains multiple scattered note folders alongside source code and you want them all visible together in one place.

**Creating a virtual workspace:**
- Click the folder-with-plus button in the explorer header
- Type a name and press `Enter` (the name is always shown in uppercase)

**Adding content** (hover the workspace header to reveal action buttons):
- **Add Folder** — opens a folder picker; the selected folder appears as a sub-section inside the virtual workspace with its own expandable file tree, new file/folder buttons, and live sync
- **Add File** — opens a file picker; the selected file appears directly in the virtual workspace

**Managing a virtual workspace** (hover to reveal):
- **Rename** — edit the workspace name inline
- **Remove folder** (per sub-folder) — removes the folder from the workspace; the folder on disk is unaffected
- **Remove file** (per file) — removes the file from the workspace; the file on disk is unaffected
- **Remove workspace** — deletes the virtual workspace entry; nothing on disk is changed

Virtual workspaces are persisted across sessions. Search covers all folders inside virtual workspaces.

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

### AI Assistant (Side Panel)

Click the bot icon in the toolbar (or the × to close) to open the AI chat panel on the right.

- **Multi-provider** — choose between OpenAI, Anthropic, and AWS Bedrock; configure via the settings gear icon
- **Current file context** — click the filename chip in the context bar to include the active file's content with your message
- **Attach workspace files** — click **Add files** to pick any markdown file from the workspace and attach it as context (multiple files supported)
- **Streaming responses** with a blinking cursor during generation; **Stop** cancels mid-stream
- **Insert last** — one-click button to insert the most recent AI response at the cursor position
- **Insert per-message** — every assistant message has an individual Insert button
- **Chat history** persists within the session; **Clear** resets it
- API keys are stored encrypted via OS-level encryption (`safeStorage`), never in plaintext
- Keys can also be supplied via environment variables — useful for CI, Docker, or shared machines where storing keys interactively is impractical
- Non-sensitive settings (active provider, model names, base URL) persisted in `localStorage`

#### AI Settings

Open AI Settings from the gear icon in the AI panel header or the toolbar.

| Provider | Configuration |
|---|---|
| **OpenAI** | API key + optional base URL override (for compatible endpoints) + model name |
| **Anthropic** | API key + model name |
| **AWS Bedrock** | AWS profile + region + model ID (no key stored — uses AWS credential chain) |

- **Key saved** badge confirms the key is stored; the input field is never pre-filled
- Delete a stored key with the trash button
- Cancel discards all changes; Save persists them

#### API Key Priority & Environment Variables

Keys are resolved in this order — the first source that has a value wins:

1. **Stored key** (saved via Settings, encrypted with `safeStorage`)
2. **Environment variable** (set before launching the app)

| Provider | Environment variable |
|---|---|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |

The settings dialog shows which source is active:

| Badge | Meaning |
|---|---|
| `Key saved` | An encrypted key is stored and will be used |
| `Key saved (overrides OPENAI_API_KEY)` | Both are present; the stored key takes precedence |
| `Using OPENAI_API_KEY` | No stored key; the environment variable will be used |
| *(hint text)* | Neither source found; shows the variable name to set |

**Setting env vars by platform:**

```bash
# macOS / Linux
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

# Windows (Command Prompt)
set OPENAI_API_KEY=sk-...

# Windows (PowerShell)
$env:OPENAI_API_KEY = "sk-..."
```

For a persistent setup add them to your shell profile (`~/.bashrc`, `~/.zshrc`) or system environment variables. For Docker or CI, inject them as container/pipeline secrets.

AWS Bedrock uses the standard AWS credential chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_PROFILE`, `AWS_REGION`) which the AWS SDK resolves automatically — no special handling required.

---

### Inline AI (Editor)

Press **`Ctrl+Shift+A`** or click the bot icon in the format toolbar to open the inline AI bar at the bottom of the editor. Only available in Edit mode.

**Two modes, detected automatically from your prompt:**

| Mode | Triggered when | Behaviour |
|---|---|---|
| **Edit** | Default; directive words like *make*, *fix*, *rewrite* | AI transforms content and shows a diff for review |
| **Ask** | Question words (*explain*, *summarize*, *why*, *how*…) or prompt ends with `?` | AI answers about the document; no changes are applied |

**Three scope levels** — buttons in the bar header let you choose what the AI targets:

| Scope | What it covers |
|---|---|
| **Selection** | Only the selected text (disabled if nothing is selected) |
| **Section** | The current markdown section from its heading to the next equal-or-higher heading |
| **Document** | The entire document |

Opening the bar with text selected defaults to Selection scope; without a selection it defaults to Document scope.

**Quick-action chips** — one-click prompts shown before the first send:

- With a selection: `Fix grammar` · `Make shorter` · `Make longer` · `Rephrase` · `To bullets`
- Without a selection: `Continue` · `Add example` · `Add table` · `Summarize doc`

**Line-targeted instructions** — reference specific lines in your prompt and the AI targets them directly:
- `"fix line 7"` / `"replace line 7"` — selects and replaces that line
- `"at the end of line 5"` / `"at the start of line 3"` — places the cursor at the specified position

**Diff view (Edit mode)** — results are broken into **hunks** (contiguous change regions) so you can review and accept or reject each change individually:

- **Accept All** — applies every hunk at once
- **Apply Selected** — applies only the hunks you have individually accepted (shows count)
- **Accept Hunk / Reject Hunk** — mark individual hunks; navigate with Prev / Next or keyboard
- **WS toggle** — switch between ignoring and preserving whitespace in the diff calculation
- Diff shows line-level changes with word-level highlights for precise comparison (red = removed, green = added)

**Refine without discarding** — after a result appears the input is re-enabled. Type a follow-up instruction (e.g. "make it shorter") and click **Refine** to iterate.

**Surrounding context** — the 4 lines before and after the target are always included in the request so the AI matches the surrounding tone, heading level, and list style.

**Prompt history** — press `↑` / `↓` in the input to recall previous prompts within the session (up to 20 entries).

**Keyboard shortcuts in the inline bar:**

| Key | Action |
|---|---|
| `Enter` (empty prompt, result visible) | Accept |
| `Tab` | Accept |
| `Escape` | Discard / close bar |
| `↑` / `↓` | Navigate prompt history |
| `J` | Next hunk |
| `K` | Previous hunk |
| `A` | Accept active hunk |
| `R` | Reject active hunk |

**Accept** inserts or replaces via the native undo stack — `Ctrl+Z` works as expected.

---

### Theming
- Light and dark themes via a single toggle button
- Preference persisted in localStorage

## Technology Stack

- **Frontend**: Angular 20+ with TypeScript
- **Desktop**: Electron (cross-platform)
- **Markdown**: Marked v16+ (GitHub Flavored Markdown) + highlight.js for code blocks
- **Styling**: SCSS with CSS custom properties design system
- **Editor font**: JetBrains Mono / Fira Code
- **AI**: OpenAI SDK, Anthropic SDK, AWS Bedrock SDK (lazy-loaded in main process)

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
| `Ctrl+Shift+I` | Open / close AI chat panel |
| `Ctrl+Shift+A` | Open inline AI bar (edit mode) |
| `Tab` / `Enter` | Accept inline AI result |
| `Escape` | Discard inline AI / close bar |
| `↑` / `↓` (inline bar) | Navigate prompt history |
| `J` / `K` (inline bar) | Next / previous hunk |
| `A` / `R` (inline bar) | Accept / reject active hunk |
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+K` | Insert link |
| `` Ctrl+` `` | Inline code |

## License

MIT
