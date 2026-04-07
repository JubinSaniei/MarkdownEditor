# FORGE.md
> Human-maintained project context for the Forge AI agent.
> Keep this file accurate — the agent reads it at the start of every session.
> Edit freely — your changes will be preserved across re-initializations.

## Overview
MarkdownEditor is an Electron-based desktop application for editing and previewing Markdown files. It provides a split-pane editor with live preview, a file explorer sidebar for workspace management, and an integrated AI chat panel that streams responses from OpenAI, Anthropic, or AWS Bedrock. The app targets Windows (NSIS installer + portable build) and is built with Angular 19 as the renderer framework inside Electron 35.

## Tech Stack
- Language: TypeScript 5.x (Angular renderer), JavaScript (Electron main process)
- Frontend Framework: Angular 19 (standalone components, zoneless change detection)
- Runtime: Electron 35 (Node.js main process + sandboxed renderer)
- Markdown Rendering: marked 15.x + highlight.js 11.x (syntax highlighting in code blocks)
- AI Providers: openai 4.x SDK, @anthropic-ai/sdk 0.39.x, @aws-sdk/client-bedrock-runtime 3.x
- Styling: SCSS (global styles.scss + per-component SCSS files, CSS custom properties for theming)
- Build: Angular CLI 19 (`ng build`), electron-builder (NSIS installer, portable .exe)
- Package Manager: npm (package-lock.json)
- Testing: Effectively none — Karma/Jasmine configured but only one default spec file exists

## Architecture
Two-process Electron architecture: the main process lives in `public/electron.js` (plain JavaScript, ~780 lines) and owns the BrowserWindow, filesystem access, directory watching, native dialogs, AI key management via `safeStorage`, and AI streaming. The renderer is an Angular 19 SPA bootstrapped in `src/main.ts` and served via Angular CLI during development. Communication between processes uses Electron IPC exclusively through `public/preload.js`, which exposes a `window.electronAPI` object with typed methods; the renderer-side `ElectronService` wraps all these calls.

The app component (`AppComponent`) acts as the orchestrator — it manages tabs, editor state, keyboard shortcuts, drag-and-drop, view modes (preview/editor/split), and coordinates between child components. Major UI components are: `FileExplorerComponent` (sidebar with workspace tree and recent files), `MarkdownEditorComponent` (CodeMirror-style textarea editor with line numbers, search/replace, and undo/redo), `MarkdownPreviewComponent` (rendered HTML preview with scroll sync), `AiPanelComponent` (streaming AI chat), and `AiSettingsComponent` (provider configuration modal). Services follow Angular's `providedIn: 'root'` singleton pattern: `FileService` handles file I/O with a 60-second directory tree cache, `SearchService` provides find/replace across the editor, `ScrollSyncService` synchronizes scroll positions between editor and preview panes, `ThemeService` manages light/dark/system themes, `AiService` manages streaming AI conversations, and `AiSettingsService` persists provider settings via localStorage.

AI keys are encrypted at rest using Electron's `safeStorage` API and stored in a JSON file in the user data directory. AI streaming uses a request-based pattern: the renderer sends `ai-stream-start` with a `requestId`, the main process streams chunks back via `ai-stream-chunk` events, and the renderer can cancel via `ai-stream-cancel`.

## Key Files
- `public/electron.js` — Electron main process; creates BrowserWindow, registers all IPC handlers (file ops, directory watching, dialogs, AI key management, AI streaming for OpenAI/Anthropic/Bedrock)
- `public/preload.js` — Preload script exposing `window.electronAPI` bridge; defines all IPC channel methods the renderer can call
- `src/main.ts` — Angular bootstrap entry point
- `src/app/app.component.ts` — Root orchestrator component (~1333 lines); manages tabs, view modes, keyboard shortcuts, drag-and-drop, file operations, and coordinates all child components
- `src/app/app.component.html` — Main layout template; sidebar + toolbar + tabbed split-pane editor/preview + AI panel
- `src/app/components/markdown-editor/markdown-editor.component.ts` — Textarea-based Markdown editor (~1711 lines); line numbers, syntax shortcuts, search/replace, auto-indent, undo/redo
- `src/app/components/markdown-preview/markdown-preview.component.ts` — Renders Markdown to HTML via `marked` + `highlight.js`; handles link interception and scroll sync
- `src/app/components/file-explorer/file-explorer.component.ts` — Sidebar with workspace roots, directory tree (lazy-loaded children), recent files, context menus
- `src/app/components/ai-panel/ai-panel.component.ts` — AI chat panel; streams responses, renders Markdown in messages, manages conversation history
- `src/app/components/ai-settings/ai-settings.component.ts` — Modal for configuring AI provider, model, API keys, system prompt
- `src/app/services/electron.service.ts` — Angular wrapper around `window.electronAPI`; all IPC calls go through here
- `src/app/services/file.service.ts` — File tree building, directory caching (60s TTL), markdown file filtering, file CRUD operations
- `src/app/services/ai.service.ts` — Manages AI streaming lifecycle (start/cancel/chunk handling) via IPC events
- `src/app/services/search.service.ts` — Find and replace across editor content with regex support, match highlighting, and navigation
- `src/app/interfaces/ai-settings.interface.ts` — TypeScript interfaces for AI provider settings, key status, and streaming payloads
- `src/styles.scss` — Global SCSS with CSS custom properties for light/dark theming

## Agent Rules
- **Build commands**: `npm start` runs Angular dev server; `npm run electron:dev` launches Electron in dev mode; `npm run electron:build` creates production build + installer; `npm run electron:portable` creates portable .exe
- **No test suite**: Testing is effectively absent — do not assume tests exist or will catch regressions. Verify changes manually or by running the app.
- **Main process is plain JS**: `public/electron.js` and `public/preload.js` are vanilla JavaScript, not TypeScript. Do not add TypeScript syntax or import statements to these files — they use `require()`.
- **IPC bridge contract**: `public/preload.js` and `src/app/services/electron.service.ts` MUST stay in sync. When adding a new IPC channel, update both the preload `contextBridge.exposeInMainWorld` call AND the ElectronService wrapper method.
- **Angular standalone components**: All components use `standalone: true` with direct imports rather than NgModule declarations. New components must follow this pattern.
- **Zoneless change detection**: The app uses `provideExperimentalZonelessChangeDetection()` — no Zone.js. State changes from async operations (IPC callbacks, timers) require explicit `ChangeDetectorRef.markForCheck()` or signals to trigger re-renders.
- **Service injection**: All services use `@Injectable({ providedIn: 'root' })` — do not add services to module `providers` arrays.
- **Styling**: Use SCSS with CSS custom properties (e.g., `var(--bg-primary)`, `var(--text-primary)`) for all colors to support light/dark themes. Never hardcode color values.
- **AI key security**: API keys are encrypted via Electron `safeStorage` and stored in the user data directory. Never log, expose, or send keys to the renderer — all AI calls happen in the main process.
- **AI streaming pattern**: Use `requestId`-based pattern for AI streams. Renderer sends `ai-stream-start` with a unique `requestId`, main process streams `ai-stream-chunk` events back, renderer can cancel via `ai-stream-cancel`. Always clean up `activeStreams` on completion or error.
- **File tree filtering**: Only `.md` and `.markdown` files are shown in the file explorer. The `FileService` cache has a 60-second TTL — call `invalidateCache()` after filesystem mutations.
- **Large component awareness**: `AppComponent` (~1333 lines) and `MarkdownEditorComponent` (~1711 lines) are very large. When modifying these, read the relevant section carefully and make targeted changes.
- **Keyboard shortcuts**: Extensive keyboard shortcuts are handled in `AppComponent.onGlobalKeyDown()`. Check for conflicts before adding new shortcuts.
- **Error handling in IPC**: Main process IPC handlers return `{ success, error? }` objects rather than throwing. Follow this pattern for new handlers.
- **Window platform**: Primary target is Windows. File paths may use backslashes. Use `path.join()` in main process and normalize separators in renderer-side path operations.