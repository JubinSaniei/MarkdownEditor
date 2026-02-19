# Markdown Editor — Improvement Plan

## Status Legend
| Symbol | Meaning |
|--------|---------|
| `[ ]` | Pending |
| `[~]` | In Progress |
| `[x]` | Done |

---

## P0 — Core UX

- [x] **1. Unsaved Changes Warning** — Track `isDirty` flag; warn before switching files or closing the app with a native Save / Don't Save / Cancel dialog.
- [x] **2. Find & Replace** — Extend the search bar with a replace input row (Replace and Replace All buttons).
- [x] **3. Search Options UI** — Expose the existing hidden `caseSensitive` [Aa], `wholeWord` [W], and `useRegex` [.*] toggles in the search bar.
- [x] **4. File Watcher** — Electron `fs.watch` via IPC detects external edits; shows a reload banner when the open file changes on disk.

---

## P1 — Editor Quality

- [x] **5. Recent Files List** — Persist the last 10 opened files in `localStorage`; display in the sidebar under a "Recent" section.
- [x] **6. View Mode Keyboard Shortcuts + Ctrl+S** — Ctrl+1 = Preview, Ctrl+2 = Edit, Ctrl+3 = Split. Ctrl+S saves even while focused inside the textarea.
- [x] **7. Auto-save** — Configurable timer (default 30 s, toggleable from toolbar). Shows a brief "Auto-saved" indicator in the status bar.
- [x] **8. Word Count / Stats Status Bar** — Bottom bar showing word, character, and line counts; updates on every keystroke.

---

## P2 — Technical Debt

- [x] **9. XSS Fix — Event Delegation for Copy Buttons** — Replace inline `onclick="copyCodeToClipboard(...)"` in rendered code blocks with a single delegated listener on the preview container.
- [x] **10. ESLint Config** — Add `.eslintrc.json` with Angular-recommended rules and a `lint` script in `package.json`.
- [x] **11. Remove Debug Console Logs** — Remove `console.log` calls left in `MarkdownPreviewComponent.renderMarkdown()`.

---

## P3 — UI Redesign

- [x] **12. Modern UI Redesign** — Overhaul visual design: VS Code-inspired sidebar, floating search/replace panel, pill-style toolbar buttons, refined color palette, 24px status bar, cleaner file explorer with section labels, consistent spacing and shadows throughout.

---

## P4 — File System Redesign (VS Code-style)

- [x] **13. Open Folder as Workspace** — Replace "add individual files" model with opening a root folder. Sidebar shows the full recursive directory tree.
- [x] **14. Directory Tree Navigation** — Full expand/collapse tree, showing all `.md` files and subdirectories recursively.
- [x] **15. Create File / Folder** — Right-click or toolbar button to create a new file or folder anywhere in the tree.
- [x] **16. Delete File / Folder** — Delete with confirmation; remove from tree.
- [x] **17. Rename File / Folder** — Inline rename (F2 / double-click on name).
- [x] **18. Persist Workspace Root** — Remember the last opened folder in `localStorage`; reopen on launch.

---

## Files Changed

| File | Items |
|------|-------|
| `plan.md` | this file |
| `public/electron.js` | 1, 4, 13–18 |
| `public/preload.js` | 1, 4, 13–18 |
| `src/app/services/electron.service.ts` | 1, 4, 13–18 |
| `src/app/services/search.service.ts` | 2, 3 |
| `src/app/app.component.ts` | 1–8 |
| `src/app/app.component.html` | 2, 3, 6, 7, 8, 12 |
| `src/app/app.component.scss` | 2, 3, 7, 8, 12 |
| `src/styles.scss` | 12 |
| `src/app/components/file-explorer/file-explorer.component.ts` | 5, 13–18 |
| `src/app/components/file-explorer/file-explorer.component.html` | 5, 12, 13–18 |
| `src/app/components/file-explorer/file-explorer.component.scss` | 12 |
| `src/app/components/markdown-editor/markdown-editor.component.scss` | 12 |
| `src/app/components/markdown-preview/markdown-preview.component.ts` | 9, 11 |
| `src/app/components/markdown-preview/markdown-preview.component.scss` | 12 |
| `.eslintrc.json` | 10 (new) |
| `package.json` | 10 |
