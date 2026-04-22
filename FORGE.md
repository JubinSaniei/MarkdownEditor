# FORGE.md
> Desktop markdown editor with multi-pane editing, AI assistance, and virtual workspaces — built on Angular + Electron.

## Stack & Commands
- Language: TypeScript 5.x · Runtime: Electron 37 (Node main + Angular 20 renderer) · Styles: SCSS · No test framework configured
- `npm run electron-dev` — start Angular dev server + Electron with hot reload
- `npm start` — start Angular dev server only (http://localhost:4200)
- `npm run build` — production Angular build to `dist/`
- `npm run build-electron` — production build + electron-builder packaging
- `npm run lint` — ESLint with `--max-warnings=0`
## Layout
The Electron main process lives in `public/electron.js` (IPC handlers, AI streaming, file watchers, window management) with its preload bridge in `public/preload.js`. The Angular renderer source is in `src/app/`: components under `src/app/components/` (ai-panel, ai-settings, file-explorer, markdown-editor, markdown-preview), services under `src/app/services/` (electron, file, ai, ai-settings, theme, scroll-sync, search), and shared interfaces in `src/app/interfaces/`. Global styles are in `src/styles.scss`; component styles are co-located `.scss` files. Static assets (icons, images) live in `src/assets/`. There are no tests in the project.
## Architecture
Two-process Electron app: the main process (`public/electron.js`) handles filesystem I/O, native dialogs, file/directory watchers, AI key encryption via `safeStorage`, and streaming AI responses from OpenAI/Anthropic/Bedrock. The renderer (`src/app/`) is a sandboxed Angular SPA bootstrapped via `AppModule` in `src/app/app.module.ts`, with all Electron access mediated through `ElectronService` which wraps the `window.electronAPI` bridge exposed by `public/preload.js`. The root `AppComponent` orchestrates a multi-group tabbed editor with preview/edit/split view modes, search & replace, drag-and-drop, session persistence (localStorage), and an AI chat side panel. AI streaming uses IPC send/on pattern (`ai-stream-start` → `ai-stream-chunk`) rather than invoke/handle, managed by `AiService` which wraps it in an RxJS Observable. The app enforces single-instance lock and supports "Open with" file association for `.md`/`.markdown` files.
## Invariants
- `public/preload.js` and `ElectronService` (`src/app/services/electron.service.ts`) MUST stay in sync — every IPC channel exposed in preload must have a corresponding wrapper method in ElectronService, and vice versa.
- AI streaming uses `ipcMain.on` / `ipcRenderer.send` (fire-and-forget), NOT `invoke/handle` — the response comes back via `ai-stream-chunk` events keyed by `requestId`. Mixing patterns will break streaming.
- `window.__dirtyState__` is read by the main process via `executeJavaScript` during window close — `updateDirtyState()` must be called on every content/tab change or the unsaved-changes dialog will show stale data.
- File watcher change events are suppressed for 1 second after a save (`saveSuppressionSet`) — modifying this timeout or skipping `suppressFileChange()` will cause false external-change warnings.
- The right editor group (`g2`) is auto-removed when its last tab is closed — never assume `this.groups` has length > 1.
- Session restore supports both legacy single-group and new multi-group localStorage formats — both code paths in `loadSettings()` must be maintained until a migration is performed.
- `contextIsolation: true` and `sandbox: true` are set on the BrowserWindow — `nodeIntegration` is OFF; all Node access must go through preload IPC.
- AI keys are stored encrypted via Electron `safeStorage` with env-var fallback (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) — keys are never stored in plain text on disk.
## Conventions
- Strict TypeScript: `strict: true`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature` in tsconfig.
- Angular strict templates: `strictTemplates: true`, `strictInjectionParameters: true`, `strictInputAccessModifiers: true`.
- Components use `standalone: false` with NgModule declarations (not standalone component API).
- Component styles use SCSS, configured via `angular.json` schematics.
- Services use `providedIn: 'root'` for singleton injection; `ThemeService` is also explicitly listed in `AppModule.providers` for `APP_INITIALIZER`.
- ESLint enforces zero warnings (`--max-warnings=0`).
- IPC channels use kebab-case naming (`read-file`, `ai-stream-start`, `watch-directory`).
- All `ElectronService` methods guard on `isElectron` and return safe fallbacks (empty string, false, empty array) when running outside Electron.
- Settings persisted to `localStorage` under key `markdownEditorSettings`; window bounds persisted to `userData/window-state.json` by the main process.
- Tab IDs are generated via `Date.now().toString()` — not UUIDs.