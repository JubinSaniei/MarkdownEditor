const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { net } = require('electron');

let mainWindow;

// ── Window state persistence ──────────────────────────────────
function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

async function loadWindowState() {
  try {
    const data = await fs.readFile(getWindowStatePath(), 'utf-8');
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

async function saveWindowState(win) {
  try {
    await fs.writeFile(getWindowStatePath(), JSON.stringify(win.getBounds()), 'utf-8');
  } catch (_) {}
}

// File watcher state
const fileWatchers = new Map();
const changeTimers = new Map();
const fileStatCache = new Map(); // filePath -> { mtimeMs, size }

// Directory watcher state
const dirWatchers = new Map();
const dirChangeTimers = new Map();

// ── AI key storage ────────────────────────────────────────────
const activeStreams = new Map(); // requestId -> AbortController

function getAiKeysPath() {
  return path.join(app.getPath('userData'), 'ai-keys.json');
}
async function loadAiKeys() {
  try { return JSON.parse(await fs.readFile(getAiKeysPath(), 'utf-8')); }
  catch (_) { return {}; }
}
async function saveAiKeys(keys) {
  await fs.writeFile(getAiKeysPath(), JSON.stringify(keys), 'utf-8');
}
const AI_ENV_VARS = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

async function getDecryptedKey(provider) {
  // Priority 1: safeStorage key (user-saved key takes precedence over env var)
  if (safeStorage.isEncryptionAvailable()) {
    const keys = await loadAiKeys();
    if (keys[provider]) {
      try { return safeStorage.decryptString(Buffer.from(keys[provider], 'base64')); }
      catch (err) {
        console.warn(`Failed to decrypt ${provider} key from safeStorage:`, err.message);
      }
    }
  }
  // Priority 2: environment variable fallback (cross-platform)
  return process.env[AI_ENV_VARS[provider]] || '';
}

// File opened via "Open with" or command-line argument
let pendingOpenFile = null;

// Extract a .md / .markdown file path from an argv array.
// argv[0] is always the executable path in both process.argv and the
// second-instance commandLine, so we always skip index 0.
function getFileArgFromArgv(argv) {
  return argv.slice(1).find(
    a => !a.startsWith('-') && /\.(md|markdown)$/i.test(a)
  ) || null;
}

async function checkAngularApp(port) {
  return new Promise((resolve) => {
    const request = net.request(`http://localhost:${port}`);
    request.on('response', (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        const isOurApp = data.includes('app-root') && (
          data.includes('Markdown Editor') ||
          data.includes('markdown-editor-app') ||
          data.includes('MarkdownEditor')
        );
        resolve(isOurApp);
      });
    });
    request.on('error', () => resolve(false));
    setTimeout(() => { request.abort(); resolve(false); }, 2000);
    request.end();
  });
}

async function findAngularDevServerPort() {
  const commonPorts = [4200, 4201, 4202, 4203, 4204, 4205, 4250];
  try {
    const port = await Promise.any(
      commonPorts.map(p => checkAngularApp(p).then(ok => ok ? p : Promise.reject()))
    );
    return port;
  } catch (_) {
    return 4200;
  }
}

async function createWindow() {
  const winState = await loadWindowState();
  const winOptions = {
    width: winState?.width || 1300,
    height: winState?.height || 800,
    minWidth: 800,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../src/assets/android-chrome-512x512.png'),
    titleBarStyle: 'default',
    show: false
  };
  if (winState?.x != null) winOptions.x = winState.x;
  if (winState?.y != null) winOptions.y = winState.y;

  mainWindow = new BrowserWindow(winOptions);

  // Show window when ready to avoid flash
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Clean up watchers and timers when window is about to close
  mainWindow.on('close', async (event) => {
    // Clean up file watchers
    for (const w of fileWatchers.values()) try { w.close(); } catch (_) {}
    for (const w of dirWatchers.values()) try { w.close(); } catch (_) {}
    for (const t of changeTimers.values()) clearTimeout(t);
    for (const t of dirChangeTimers.values()) clearTimeout(t);
    fileWatchers.clear();
    dirWatchers.clear();
    changeTimers.clear();
    dirChangeTimers.clear();

    event.preventDefault();
    try {
      const dirtyState = await mainWindow.webContents.executeJavaScript('window.__dirtyState__ || null');
      if (!dirtyState || !dirtyState.isDirty) {
        await saveWindowState(mainWindow);
        mainWindow.destroy();
        return;
      }
      const fileName = dirtyState.fileName || 'Untitled';
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Unsaved Changes',
        message: `Save changes to "${fileName}"?`,
        detail: 'Your changes will be lost if you close without saving.'
      });
      if (result.response === 0) {
        if (dirtyState.filePath && dirtyState.content !== undefined) {
          try {
            await fs.writeFile(dirtyState.filePath, dirtyState.content, 'utf-8');
          } catch (e) {
            console.error('Failed to save file on close:', e);
            dialog.showErrorBox('Save Failed', `Could not save "${fileName}":\n${e.message}`);
          }
        }
        await saveWindowState(mainWindow);
        mainWindow.destroy();
      } else if (result.response === 1) {
        await saveWindowState(mainWindow);
        mainWindow.destroy();
      }
      // response === 2: Cancel — keep window open
    } catch (err) {
      console.error('Error during window close:', err);
      await saveWindowState(mainWindow);
      mainWindow.destroy();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';
  let url;

  if (isDev) {
    const port = await findAngularDevServerPort();
    url = `http://localhost:${port}`;
  } else {
    url = path.join(__dirname, '../dist/index.html');
  }

  try {
    if (isDev) {
      await mainWindow.loadURL(url);
    } else {
      await mainWindow.loadFile(url);
    }
  } catch (error) {
    if (isDev) {
      dialog.showErrorBox('Dev Server Not Found',
        'Could not connect to Angular dev server.\nRun: npm start\n\nThe app will now close.');
      app.quit();
    }
  }

  // Right-click menu. Electron ships no default context menu, so everything —
  // spelling suggestions AND ordinary copy/paste — has to be built here.
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menuItems = [];

    // Spelling suggestions first, when right-clicking a misspelled word.
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        menuItems.push({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion)
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuItems.push({ label: 'No suggestions', enabled: false });
      }
      menuItems.push({ type: 'separator' });
      menuItems.push({
        label: 'Add to Dictionary',
        click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
      menuItems.push({ type: 'separator' });
    }

    const hasSelection = params.selectionText && params.selectionText.trim().length > 0;
    const isEditable = params.isEditable;

    if (isEditable) {
      menuItems.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' });
      menuItems.push({ role: 'cut', enabled: hasSelection });
      menuItems.push({ role: 'copy', enabled: hasSelection });
      menuItems.push({ role: 'paste' });
      menuItems.push({ type: 'separator' });
      // Scoped to the focused field, which is what the user expects here.
      menuItems.push({ role: 'selectAll' });
    } else {
      // On read-only content "Select All" targets the whole document and would
      // highlight the entire window, so it is deliberately omitted.
      menuItems.push({ role: 'copy', enabled: hasSelection });
    }

    // Copy a link target when one was right-clicked.
    if (params.linkURL) {
      menuItems.push({ type: 'separator' });
      menuItems.push({
        label: 'Copy Link Address',
        click: () => require('electron').clipboard.writeText(params.linkURL)
      });
    }

    Menu.buildFromTemplate(menuItems).popup();
  });

  // Block F5 / Ctrl+R (reload) and all DevTools shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // Reload shortcuts
    if (input.code === 'F5') { event.preventDefault(); return; }
    if ((input.control || input.meta) && input.code === 'KeyR') { event.preventDefault(); return; }
    // Block F12 DevTools shortcut (Ctrl+Shift+I / Cmd+Alt+I remain available)
    if (input.code === 'F12') { event.preventDefault(); return; }
  });
}

// ── Single-instance lock ──────────────────────────────────────
// If another instance is already running, forward the file path to it and quit.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  // A second instance was launched — bring the existing window to front
  // and tell the renderer to open the file.
  app.on('second-instance', (event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const filePath = getFileArgFromArgv(commandLine);
      if (filePath && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('open-file', filePath);
      }
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Capture file passed via "Open with" before creating the window
    pendingOpenFile = getFileArgFromArgv(process.argv);
    await createWindow();
  });

  app.on('before-quit', () => {
    for (const ac of activeStreams.values()) try { ac.abort(); } catch (_) {}
    activeStreams.clear();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
}

// ============================================================
// IPC Handlers — File Dialogs
// ============================================================

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return (!result.canceled && result.filePaths.length > 0) ? result.filePaths[0] : null;
});

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return (!result.canceled && result.filePaths.length > 0) ? result.filePaths[0] : null;
});

ipcMain.handle('select-multiple-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return (!result.canceled && result.filePaths.length > 0) ? result.filePaths : [];
});

ipcMain.handle('select-folder-or-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    defaultPath: process.cwd(),
    title: 'Select Markdown File',
    buttonLabel: 'Select File'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return { path: result.filePaths[0], isDirectory: false };
  }
  return null;
});

// ============================================================
// IPC Handlers — File Read / Write
// ============================================================

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error('Not a file');
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    console.error('Error reading file:', error);
    return '';
  }
});

ipcMain.handle('write-file', async (event, filePath, content) => {
  try {
    await fs.writeFile(filePath, content, 'utf-8');
    return true;
  } catch (error) {
    console.error('Error writing file:', error);
    return false;
  }
});

ipcMain.handle('save-file-as', async (event, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePath) {
    try {
      await fs.writeFile(result.filePath, content, 'utf-8');
      return { success: true, filePath: result.filePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, cancelled: true };
});

// ============================================================
// IPC Handlers — Directory Tree
// ============================================================

ipcMain.handle('get-directory-contents', async (event, dirPath) => {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const contents = [];

    for (const item of items) {
      // Skip hidden files/folders (starting with '.')
      if (item.name.startsWith('.')) continue;
      // Skip node_modules and common build output dirs
      if (item.isDirectory() && ['node_modules', 'dist', '.git', '.angular', '__pycache__'].includes(item.name)) continue;

      const itemPath = path.join(dirPath, item.name);
      contents.push({
        name: item.name,
        path: itemPath,
        isDirectory: item.isDirectory()
      });
    }

    contents.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });

    return contents;
  } catch (error) {
    console.error('Error reading directory:', error);
    return [];
  }
});

// ============================================================
// IPC Handlers — Create / Delete / Rename
// ============================================================

ipcMain.handle('create-new-file', async (event, defaultPath) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Create New Markdown File',
    defaultPath: defaultPath ? path.join(defaultPath, 'untitled.md') : 'untitled.md',
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePath) {
    try {
      const defaultContent = '# New Document\n\nStart writing your markdown here...\n';
      await fs.writeFile(result.filePath, defaultContent, 'utf-8');
      return { success: true, filePath: result.filePath, content: defaultContent };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, cancelled: true };
});

ipcMain.handle('create-file-at-path', async (event, filePath, content = '') => {
  try {
    await fs.writeFile(filePath, content, { flag: 'wx', encoding: 'utf-8' });
    return { success: true, filePath };
  } catch (error) {
    if (error.code === 'EEXIST') return { success: false, error: 'File already exists' };
    return { success: false, error: error.message };
  }
});

ipcMain.handle('create-folder-at-path', async (event, folderPath) => {
  try {
    await fs.mkdir(folderPath, { recursive: false });
    return { success: true, folderPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rename-path', async (event, oldPath, newPath) => {
  try {
    await fs.rename(oldPath, newPath);
    return { success: true, newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete File',
    message: 'Are you sure you want to delete this file?',
    detail: `This action cannot be undone.\n\nFile: ${path.basename(filePath)}`
  });
  if (result.response === 0) {
    try {
      await fs.unlink(filePath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, cancelled: true };
});

ipcMain.handle('delete-path', async (event, itemPath) => {
  try {
    const stats = await fs.stat(itemPath);
    const name = path.basename(itemPath);
    const isDir = stats.isDirectory();

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: `Delete ${isDir ? 'Folder' : 'File'}`,
      message: `Delete "${name}"?`,
      detail: isDir
        ? 'This will permanently delete the folder and all its contents. This cannot be undone.'
        : 'This action cannot be undone.'
    });

    if (result.response === 0) {
      if (isDir) {
        await fs.rm(itemPath, { recursive: true, force: true });
      } else {
        await fs.unlink(itemPath);
      }
      return { success: true };
    }
    return { success: false, cancelled: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================================
// IPC Handlers — File Watcher
// ============================================================

ipcMain.handle('watch-file', (event, filePath) => {
  if (fileWatchers.has(filePath)) {
    try { fileWatchers.get(filePath).close(); } catch (_) {}
  }
  try {
    // Snapshot current mtime/size so later events that don't actually
    // change file content (e.g. mere opens/touches) can be filtered out.
    try {
      const stat = fsSync.statSync(filePath);
      fileStatCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (_) {
      fileStatCache.delete(filePath);
    }
    const watcher = fsSync.watch(filePath, () => {
      if (changeTimers.has(filePath)) clearTimeout(changeTimers.get(filePath));
      changeTimers.set(filePath, setTimeout(() => {
        changeTimers.delete(filePath);
        // Cheap stat check — avoids flagging events where content didn't
        // actually change (e.g. file opened elsewhere, mtime touch only).
        let changed = true;
        try {
          const stat = fsSync.statSync(filePath);
          const prev = fileStatCache.get(filePath);
          if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
            changed = false;
          }
          fileStatCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
        } catch (_) {
          // File may have been deleted/renamed — still notify.
        }
        if (changed && mainWindow && !mainWindow.isDestroyed()) {
          try { mainWindow.webContents.send('file-changed', filePath); } catch (_) {}
        }
      }, 500));
    });
    watcher.on('error', () => {
      fileWatchers.delete(filePath);
      fileStatCache.delete(filePath);
      if (changeTimers.has(filePath)) {
        clearTimeout(changeTimers.get(filePath));
        changeTimers.delete(filePath);
      }
    });
    fileWatchers.set(filePath, watcher);
    return true;
  } catch (_) {
    return false;
  }
});

ipcMain.handle('unwatch-file', (event, filePath) => {
  if (fileWatchers.has(filePath)) {
    try { fileWatchers.get(filePath).close(); } catch (_) {}
    fileWatchers.delete(filePath);
  }
  fileStatCache.delete(filePath);
  if (changeTimers.has(filePath)) {
    clearTimeout(changeTimers.get(filePath));
    changeTimers.delete(filePath);
  }
  return true;
});

ipcMain.handle('watch-directory', (event, dirPath) => {
  if (dirWatchers.has(dirPath)) {
    try { dirWatchers.get(dirPath).close(); } catch (_) {}
  }
  try {
    const watcher = fsSync.watch(dirPath, { recursive: true }, () => {
      if (dirChangeTimers.has(dirPath)) clearTimeout(dirChangeTimers.get(dirPath));
      dirChangeTimers.set(dirPath, setTimeout(() => {
        dirChangeTimers.delete(dirPath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          try { mainWindow.webContents.send('directory-changed', dirPath); } catch (_) {}
        }
      }, 300));
    });
    watcher.on('error', () => {
      dirWatchers.delete(dirPath);
      if (dirChangeTimers.has(dirPath)) {
        clearTimeout(dirChangeTimers.get(dirPath));
        dirChangeTimers.delete(dirPath);
      }
    });
    dirWatchers.set(dirPath, watcher);
    return true;
  } catch (_) {
    return false;
  }
});

ipcMain.handle('unwatch-directory', (event, dirPath) => {
  if (dirWatchers.has(dirPath)) {
    try { dirWatchers.get(dirPath).close(); } catch (_) {}
    dirWatchers.delete(dirPath);
  }
  if (dirChangeTimers.has(dirPath)) {
    clearTimeout(dirChangeTimers.get(dirPath));
    dirChangeTimers.delete(dirPath);
  }
  return true;
});

// ============================================================
// IPC Handlers — Shell
// ============================================================

ipcMain.handle('open-external', async (event, url) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    await shell.openExternal(url);
    return true;
  } catch (_) {
    return false;
  }
});

// ============================================================
// IPC Handlers — Open With / CLI file argument
// ============================================================

// Called by the renderer on startup to retrieve any file that was passed
// via "Open with" or a command-line argument.
ipcMain.handle('get-initial-file', () => {
  const file = pendingOpenFile;
  pendingOpenFile = null;   // consume it so re-opens don't repeat
  return file;
});

// ============================================================
// IPC Handlers — AI Key Management (safeStorage)
// ============================================================

ipcMain.handle('ai-key-set', async (event, provider, key) => {
  if (!safeStorage.isEncryptionAvailable())
    return { success: false, error: 'OS encryption not available' };
  const keys = await loadAiKeys();
  keys[provider] = safeStorage.encryptString(key).toString('base64');
  await saveAiKeys(keys);
  return { success: true };
});

ipcMain.handle('ai-key-get', async (event, provider) => getDecryptedKey(provider));

ipcMain.handle('ai-key-delete', async (event, provider) => {
  const keys = await loadAiKeys();
  delete keys[provider];
  await saveAiKeys(keys);
  return { success: true };
});

ipcMain.handle('ai-key-status', async () => {
  const keys = await loadAiKeys();
  return {
    openaiKeySet:     !!keys['openai'],
    anthropicKeySet:  !!keys['anthropic'],
    openaiEnvKey:     !!process.env[AI_ENV_VARS['openai']],
    anthropicEnvKey:  !!process.env[AI_ENV_VARS['anthropic']],
  };
});

/**
 * Where a provider's key actually came from — the same precedence
 * getDecryptedKey() uses. Surfaced in the UI so a stale environment variable
 * silently shadowing (or standing in for) a saved key is immediately visible.
 */
async function getKeySource(provider) {
  if (safeStorage.isEncryptionAvailable()) {
    const keys = await loadAiKeys();
    if (keys[provider]) {
      try {
        safeStorage.decryptString(Buffer.from(keys[provider], 'base64'));
        return 'saved';
      } catch (_) {
        return 'saved-corrupt'; // stored but undecryptable — we silently fall through to env
      }
    }
  }
  return process.env[AI_ENV_VARS[provider]] ? 'env' : 'none';
}

/** Mask a credential for display: keep the prefix, which identifies its type. */
function maskKey(key) {
  if (!key) return '(empty)';
  return key.length <= 12 ? `${key.slice(0, 4)}…` : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

// ============================================================
// IPC Handlers — Claude CLI Session History
// ============================================================
//
// Claude Code stores each conversation as a JSONL transcript under
//   <configDir>/projects/<slugified-cwd>/<session-uuid>.jsonl
// The slug is lossy (":" "\" "." all become "-"), so it cannot be decoded back
// into a path. Every entry carries its own "cwd" field though, which is the
// reliable way to learn where a session must be resumed from.

function claudeConfigRoot(payload) {
  const dir = ((payload && payload.claudeCliConfigDir) || '').trim();
  return dir || path.join(require('os').homedir(), '.claude');
}

/** A transcript message's text: content is either a string or content blocks. */
function extractTranscriptText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('');
  }
  return '';
}

async function parseClaudeTranscript(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const messages = [];
  let sessionId = null, cwd = null, summary = null, updatedAt = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch (_) { continue; }

    if (!sessionId && evt.sessionId) sessionId = evt.sessionId;
    if (!cwd && evt.cwd) cwd = evt.cwd;
    if (evt.type === 'summary' && typeof evt.summary === 'string') summary = evt.summary;
    if (evt.timestamp) updatedAt = evt.timestamp;

    // Sidechains are sub-agent branches, not part of the visible conversation.
    if (evt.isSidechain) continue;
    if (evt.type === 'user' || evt.type === 'assistant') {
      const text = extractTranscriptText(evt.message);
      if (text && text.trim()) messages.push({ role: evt.type, content: text });
    }
  }

  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');
  return { sessionId, cwd, summary, updatedAt, messages };
}

// ── This app's own session index ──────────────────────────────
//
// Claude Code decides where transcripts live, so instead of guessing which of
// its buckets belong to us, we keep our own manifest in the Session Scope
// folder: sessions.json, one entry per conversation WE started, each holding
// the resolved path to the real .jsonl. The history picker reads this, so it
// lists our conversations and nothing else.

function sessionScopeDir(payload) {
  return ((payload && payload.claudeCliWorkingDir) || '').trim() || app.getPath('userData');
}

function sessionIndexPath(payload) {
  return path.join(sessionScopeDir(payload), 'sessions.json');
}

async function readSessionIndex(payload) {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionIndexPath(payload), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Locate a session's transcript by UUID. The bucket name is a lossy slug of the
 * cwd and cannot be recomputed reliably, but the FILE name is exactly
 * "<session-id>.jsonl" — so probe each bucket for that name.
 */
async function findTranscriptPath(payload, sessionId) {
  if (!sessionId) return null;
  const root = path.join(claudeConfigRoot(payload), 'projects');
  for (const bucket of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!bucket.isDirectory()) continue;
    const candidate = path.join(root, bucket.name, `${sessionId}.jsonl`);
    try { await fs.access(candidate); return candidate; } catch (_) {}
  }
  return null;
}

/** Upsert one conversation into our manifest. Called after every turn. */
ipcMain.handle('claude-cli-record-session', async (event, payload = {}) => {
  try {
    if (!payload.sessionId) return { ok: false, error: 'No session id' };
    const dir = sessionScopeDir(payload);
    await fs.mkdir(dir, { recursive: true });

    const list = await readSessionIndex(payload);
    const existing = list.find(s => s.sessionId === payload.sessionId);
    const now = Date.now();

    const entry = {
      sessionId: payload.sessionId,
      // Our own title: the question the user actually typed, without the
      // document context this app prepends to the outgoing prompt.
      title: payload.title || (existing && existing.title) || 'Conversation',
      cwd: payload.cwd || dir,
      transcriptPath: (await findTranscriptPath(payload, payload.sessionId))
                      || (existing && existing.transcriptPath) || null,
      messageCount: payload.messageCount || 0,
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
    };

    const next = [entry, ...list.filter(s => s.sessionId !== payload.sessionId)].slice(0, 200);
    await fs.writeFile(sessionIndexPath(payload), JSON.stringify(next, null, 2), 'utf-8');
    return { ok: true, entry };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('claude-cli-list-sessions', async (event, payload = {}) => {
  try {
    // Read ONLY our own manifest. Other Claude Code conversations in the config
    // home belong to the user's terminal work and are none of this app's
    // business, so they are never listed here.
    const out = [];
    for (const entry of await readSessionIndex(payload)) {
      let file = entry.transcriptPath;
      if (!file || !fsSync.existsSync(file)) {
        // Transcript moved (e.g. config directory changed) - re-resolve by id.
        file = await findTranscriptPath(payload, entry.sessionId);
      }
      if (!file) continue; // conversation no longer on disk
      out.push({
        sessionId: entry.sessionId,
        filePath: file,
        cwd: entry.cwd || '',
        title: entry.title || 'Conversation',
        messageCount: entry.messageCount || 0,
        updatedAt: entry.updatedAt || 0,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (_) {
    return [];
  }
});

ipcMain.handle('claude-cli-load-session', async (event, { filePath } = {}) => {
  try {
    const parsed = await parseClaudeTranscript(filePath);
    return {
      ok: true,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd || '',
      messages: parsed.messages,
    };
  } catch (err) {
    return { ok: false, error: err.message, messages: [] };
  }
});

// ============================================================
// IPC Handlers — AI Connection Test
// ============================================================

/**
 * Probe a provider endpoint with a minimal request and report exactly what
 * came back. The point is to separate "our app / our key is wrong" from
 * "the gateway or its upstream credential is wrong" — a distinction the
 * chat error message alone cannot make.
 */
ipcMain.handle('ai-test-connection', async (event, payload = {}) => {
  const provider = payload.provider;
  try {
    if (provider === 'claude-cli') {
      // Two stages again: does the binary exist, and does a real (tool-free)
      // round trip actually produce text?
      const { spawn } = require('child_process');
      const cliPath = (payload.claudeCliPath || 'claude').trim() || 'claude';
      const cwd = (payload.claudeCliWorkingDir || '').trim() || app.getPath('userData');
      const isWindows = process.platform === 'win32';

      const runCli = (cliArgs, stdinText, timeoutMs = 45000) => new Promise((resolve) => {
        let out = '', err = '', settled = false;
        const cliEnv = buildClaudeCliEnv(payload);
        const child = isWindows
          ? spawn([cliPath, ...cliArgs].map(quoteWinArg).join(' '), { cwd, env: cliEnv, shell: true, windowsHide: true })
          : spawn(cliPath, cliArgs, { cwd, env: cliEnv, windowsHide: true });
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { child.kill(); } catch (_) {}
          resolve(result);
        };
        const timer = setTimeout(() => finish({ code: -1, out, err: `Timed out after ${timeoutMs / 1000}s` }), timeoutMs);
        child.on('error', (e) => finish({ code: -1, out, err: e.message }));
        child.stdout.on('data', d => {
          out += d;
          // Bail out on the first auth failure instead of sitting through the
          // CLI's ten backing-off retries.
          if (/"subtype"\s*:\s*"api_retry"[\s\S]*?"error_status"\s*:\s*(401|403)/.test(out)) {
            finish({ code: -1, out, err: 'Authentication failed (HTTP 401/403). The Claude CLI itself is not logged in.' });
          }
        });
        child.stderr.on('data', d => { err += d; });
        // Same EPIPE guard as the stream path — `claude --version` exits fast.
        child.stdin.on('error', () => {});
        if (stdinText !== undefined) { try { child.stdin.write(stdinText); child.stdin.end(); } catch (_) {} }
        else { try { child.stdin.end(); } catch (_) {} }
        child.on('close', (code) => finish({ code, out, err }));
      });

      const stages = [];
      const version = await runCli(['--version']);
      stages.push({
        name: 'CLI found', url: cliPath, ok: version.code === 0,
        message: version.code === 0 ? version.out.trim() : (version.err.trim() || `exit ${version.code}`),
      });

      if (version.code === 0) {
        // A probe is a real turn, so without this every "Test connection" click
        // would leave an orphan transcript in the user's session folder.
        const probeArgs = [...buildClaudeCliArgs(payload), '--no-session-persistence'];
        if (payload.claudeCliModel) probeArgs.push('--model', payload.claudeCliModel);
        const turn = await runCli(probeArgs, 'Reply with the single word: ok');
        const gotText = /"type"\s*:\s*"result"/.test(turn.out) || turn.out.trim().length > 0;
        stages.push({
          name: 'Round trip', url: `${cliPath} -p (tools disabled)`,
          ok: turn.code === 0 && gotText,
          message: turn.code === 0 && gotText
            ? 'Completed a tool-free turn.'
            : (turn.err.trim() || turn.out.slice(-400) || `exit ${turn.code}`),
        });
      }

      const failedStage = stages.find(s => !s.ok);
      const effectiveConfigDir = (payload.claudeCliConfigDir || '').trim();
      return {
        ok: !failedStage,
        provider,
        url: cliPath,
        // Echo the identity actually used. If this shows the default while the
        // UI has a path set, the main process is stale (electron.js does not
        // hot-reload) — which is otherwise indistinguishable from a bad login.
        keySource: `CLAUDE_CONFIG_DIR = ${effectiveConfigDir || '(default ~/.claude)'}` +
                   `${payload.claudeCliSafeMode === false ? ', safe mode OFF' : ''}`,
        keyPreview: cwd,
        stages,
        message: failedStage
          ? `${failedStage.message}${describeClaudeEnvOverrides()}`
          : 'Claude CLI is installed, authenticated, and answering with tools disabled.',
      };
    }

    if (provider === 'bedrock') {
      const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
      const { fromIni } = require('@aws-sdk/credential-providers');
      const region = payload.bedrockRegion || 'us-east-1';
      const creds = await fromIni({ profile: payload.bedrockProfile || 'default' })();
      return {
        ok: true,
        provider,
        url: `bedrock:${region}`,
        keySource: `aws profile "${payload.bedrockProfile || 'default'}"`,
        status: 200,
        message: `Resolved AWS credentials (accessKeyId ${maskKey(creds.accessKeyId)}${creds.sessionToken ? ', temporary session token' : ''}).`
      };
    }

    const isAnthropic = provider === 'anthropic';
    const key = await getDecryptedKey(provider);
    const keySource = await getKeySource(provider);
    if (!key) {
      return {
        ok: false, provider, keySource,
        message: `No key found. Save one in AI Settings or set ${AI_ENV_VARS[provider]}.`
      };
    }

    // Probe in two stages, because they fail for completely different reasons:
    //   1. a metadata/listing call — served by the gateway itself, so it only
    //      proves the host is up and OUR key is accepted;
    //   2. a real (1-token) completion — forces the gateway to use ITS OWN
    //      upstream credential, which is where expired OAuth sessions surface.
    // A green stage 1 with a red stage 2 means the problem is the gateway's
    // upstream auth, not anything configured in this app.
    const stages = [];
    const probe = async (name, url, options) => {
      try {
        const res = await fetch(url, options);
        const raw = await res.text();
        stages.push({
          name, url, ok: res.ok, status: res.status,
          message: res.ok ? 'OK' : (raw.slice(0, 400) || res.statusText),
        });
        return res.ok;
      } catch (err) {
        stages.push({ name, url, ok: false, message: `Could not reach endpoint: ${err.message}` });
        return false;
      }
    };

    if (isAnthropic) {
      const base = normalizeAnthropicBaseUrl(payload.anthropicBaseUrl) || 'https://api.anthropic.com';
      await probe('Endpoint + your key', `${base}/v1/models`, {
        method: 'GET',
        headers: { 'x-api-key': key, 'authorization': `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
      });
      await probe('Upstream model call', `${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'authorization': `Bearer ${key}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: payload.anthropicModel || 'claude-sonnet-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
    } else {
      const base = (payload.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      await probe('Endpoint + your key', `${base}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}` },
      });
      await probe('Upstream model call', `${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: payload.openaiModel || 'gpt-4o',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
    }

    const failed = stages.find(s => !s.ok);
    return {
      ok: !failed,
      provider,
      url: stages[stages.length - 1]?.url,
      status: failed ? failed.status : 200,
      keySource,
      keyPreview: maskKey(key),
      stages,
      message: !failed
        ? 'Endpoint reachable, your key accepted, and a real completion succeeded.'
        : failed.name === 'Upstream model call' && stages[0]?.ok
          ? `Your key is fine — the gateway accepted it — but its own upstream call failed:\n\n${failed.message}\n\nThis must be fixed on the gateway host, not in this app.`
          : failed.message,
    };
  } catch (err) {
    // Network-level failure: wrong host/port, TLS, or nothing listening.
    return {
      ok: false,
      provider,
      message: `Could not reach endpoint: ${err.message}`,
    };
  }
});

// ============================================================
// IPC Handlers — AI Folder Grep
// ============================================================

const GREP_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.angular', 'dist', 'dist-electron',
  'build', '__pycache__', '.vscode', '.idea', '.cache'
]);

ipcMain.handle('grep-md-files', async (event, { dirPath, keywords, maxResults }) => {
  try {
    const { glob } = require('fs/promises');
    const limit = maxResults || 10;
    const MAX_FILE_SIZE = 102400; // 100 KB

    // 1. Collect all .md files using built-in glob
    const filePaths = [];
    for await (const entry of glob('**/*.md', {
      cwd: dirPath,
      exclude: (name) => GREP_EXCLUDED_DIRS.has(name)
    })) {
      filePaths.push(path.join(dirPath, entry));
    }

    // 2. Read each file and score by keyword matches
    //    Headings (# lines) get 3× weight, body text gets 1×.
    const scored = [];
    for (const filePath of filePaths) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;

        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const headingText = lines.filter(l => l.startsWith('#')).join(' ').toLowerCase();
        const bodyText    = lines.filter(l => !l.startsWith('#')).join(' ').toLowerCase();

        let score = 0;
        for (const kw of keywords) {
          const kwLower = kw.toLowerCase();
          if (headingText.includes(kwLower)) score += 3;
          if (bodyText.includes(kwLower))    score += 1;
        }

        if (score > 0) {
          const relativePath = path.relative(dirPath, filePath).replace(/\\/g, '/');
          scored.push({
            name: path.basename(filePath),
            path: filePath,
            relativePath,
            content,
            score
          });
        }
      } catch (_) { /* skip unreadable files */ }
    }

    // 3. Return top N by score (highest first)
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch (err) {
    console.error('grep-md-files error:', err);
    return [];
  }
});

// ============================================================
// IPC Handlers — AI Streaming
// ============================================================

ipcMain.on('ai-stream-start', async (event, payload) => {
  const { requestId, provider } = payload;
  const ac = new AbortController();
  activeStreams.set(requestId, ac);
  // `extra` carries provider-specific fields (sessionId, usage) without
  // disturbing the existing (type, text, error) call sites.
  const send  = (type, text, error, extra) =>
    event.sender.send('ai-stream-chunk', { requestId, type, text, error, ...(extra || {}) });
  try {
    if      (provider === 'openai')     await streamOpenAi(payload, ac.signal, send);
    else if (provider === 'anthropic')  await streamAnthropic(payload, ac.signal, send);
    else if (provider === 'bedrock')    await streamBedrock(payload, ac.signal, send);
    else if (provider === 'claude-cli') await streamClaudeCli(payload, ac.signal, send);
    else send('error', undefined, `Unknown provider: ${provider}`);
  } catch (err) {
    if (!ac.signal.aborted) send('error', undefined, err.message || 'Stream error');
  } finally {
    activeStreams.delete(requestId);
  }
});

ipcMain.handle('ai-stream-cancel', (event, requestId) => {
  const ac = activeStreams.get(requestId);
  if (ac) { ac.abort(); activeStreams.delete(requestId); }
});

// ============================================================
// AI Provider Stream Functions
// ============================================================

async function streamOpenAi(payload, signal, send) {
  const openaiModule = require('openai');
  const OpenAI = openaiModule.default || openaiModule;
  const key = await getDecryptedKey('openai');
  const client = new OpenAI({
    apiKey: key,
    ...(payload.openaiBaseUrl ? { baseURL: payload.openaiBaseUrl } : {})
  });
  const history = (payload.history || []).map(m => ({ role: m.role, content: m.content }));
  const stream = await client.chat.completions.create({
    model: payload.openaiModel || 'gpt-4o',
    messages: [
      ...(payload.systemPrompt ? [{ role: 'system', content: payload.systemPrompt }] : []),
      ...history,
      { role: 'user', content: payload.prompt }
    ],
    stream: true,
  }, { signal });
  for await (const chunk of stream) {
    if (signal.aborted) break;
    const text = chunk.choices?.[0]?.delta?.content ?? '';
    if (text) send('chunk', text);
  }
  send('done');
}

/**
 * Normalize a user-supplied Anthropic base URL.
 *
 * The Anthropic SDK appends the full path itself ("/v1/messages"), so a base
 * URL that already ends in "/v1" produces ".../v1/v1/messages". Gateways such
 * as LiteLLM / one-api document their endpoint as "<host>/v1/messages", which
 * makes users paste the "/v1" suffix — strip it so both forms work.
 */
function normalizeAnthropicBaseUrl(url) {
  if (!url) return '';
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

async function streamAnthropic(payload, signal, send) {
  const anthropicModule = require('@anthropic-ai/sdk');
  const Anthropic = anthropicModule.default || anthropicModule;
  const key = await getDecryptedKey('anthropic');
  if (!key) {
    send('error', undefined, 'No Anthropic API key found. Save one in AI Settings or set ANTHROPIC_API_KEY.');
    return;
  }
  const baseURL = normalizeAnthropicBaseUrl(payload.anthropicBaseUrl);
  const client = new Anthropic({
    apiKey: key,
    ...(baseURL ? { baseURL } : {}),
    // The official API authenticates via "x-api-key" (the SDK sends this
    // automatically). Most self-hosted proxies are OpenAI-compatible and only
    // read "Authorization: Bearer ...", so send both when a custom host is used.
    ...(baseURL ? { defaultHeaders: { Authorization: `Bearer ${key}` } } : {})
  });
  const history = (payload.history || []).map(m => ({ role: m.role, content: m.content }));
  const stream = client.messages.stream({
    model: payload.anthropicModel || 'claude-sonnet-4-5',
    max_tokens: 4096,
    signal,
    ...(payload.systemPrompt ? { system: payload.systemPrompt } : {}),
    messages: [...history, { role: 'user', content: payload.prompt }],
  });
  for await (const event of stream) {
    if (signal.aborted) break;
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
      send('chunk', event.delta.text);
  }
  send('done');
}

// ── Claude Code CLI provider ──────────────────────────────────
//
// Runs the local `claude` binary in print mode as a pure chat transport.
// Everything agentic is switched off: no tools, no MCP servers, no slash
// commands. The CLI is used ONLY because it owns the conversation transcript —
// which is precisely what preserves the prompt cache across turns.

/** Args that never change. Kept constant so the cached prefix stays stable. */
const CLAUDE_CLI_STATIC_ARGS = [
  '-p',                          // print mode (non-interactive)
  '--output-format', 'stream-json',
  '--verbose',                   // required for stream-json in print mode
  '--include-partial-messages',  // token-level deltas instead of one big blob
  '--tools', '',                 // "" disables every built-in tool
  '--strict-mcp-config',         // ignore all MCP config files (none passed)
  '--disable-slash-commands',    // no skills/commands
];

/**
 * --tools/--strict-mcp-config do NOT stop plugins, hooks or CLAUDE.md from
 * loading (verified: a SessionStart hook fired and two plugins loaded anyway).
 * --safe-mode disables every customization, which keeps the cached prefix
 * stable — but corporate setups often inject ANTHROPIC_BASE_URL / auth tokens
 * through the very settings files it ignores, so it stays switchable.
 */
function buildClaudeCliArgs(payload) {
  const args = [...CLAUDE_CLI_STATIC_ARGS];
  if (payload.claudeCliSafeMode !== false) args.push('--safe-mode');
  return args;
}

/**
 * Environment for the spawned CLI. CLAUDE_CONFIG_DIR picks the config *home*
 * (account + credentials + plugins), which is how people keep several Claude
 * logins side by side — e.g. a work install in ~/.claude and a personal one in
 * ~/.claude-max. Without it the CLI silently uses whichever account is default,
 * which is a confusing way to get a 401.
 */
/**
 * Environment variables that override where the CLI sends traffic and how it
 * authenticates. These beat the config directory, so a stale ANTHROPIC_BASE_URL
 * pointing at a dead gateway produces a 401 no matter which account you select.
 * Reported (names only, never values) when a connection test fails.
 */
function describeClaudeEnvOverrides() {
  const names = Object.keys(process.env)
    .filter(k => /^(ANTHROPIC_|CLAUDE_CODE_)/i.test(k))
    .sort();
  if (names.length === 0) return '';
  return `\n\nInherited environment overrides: ${names.join(', ')}\n` +
         `These take precedence over the config directory. If one of them points ` +
         `at a gateway or token that no longer works, that is the 401 — unset it ` +
         `in the shell you launch the app from.`;
}

function buildClaudeCliEnv(payload) {
  const env = { ...process.env };

  // ANTHROPIC_* beats CLAUDE_CONFIG_DIR, so a corporate gateway exported in the
  // shell hijacks every request no matter which account you selected. Deleting
  // the variables is the only way to let the config directory's own login win —
  // adding to the environment cannot override what is already there.
  if (payload.claudeCliIgnoreEnvAuth !== false) {
    for (const key of Object.keys(env)) {
      if (/^ANTHROPIC_/i.test(key)) delete env[key];
    }
  }

  const configDir = (payload.claudeCliConfigDir || '').trim();
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/** Give up on a single turn after this long (the CLI itself retries for ~3 min). */
const CLAUDE_CLI_TIMEOUT_MS = 120000;

/** Quote one argument for cmd.exe (Windows spawns through a shell for .cmd shims). */
function quoteWinArg(arg) {
  return `"${String(arg).replace(/"/g, '""')}"`;
}

async function streamClaudeCli(payload, signal, send) {
  const { spawn } = require('child_process');
  const { randomUUID } = require('crypto');

  const cliPath = (payload.claudeCliPath || 'claude').trim() || 'claude';
  // Sessions are stored per working directory, so this must be stable across
  // turns or --resume silently fails to find the conversation.
  const cwd = (payload.claudeCliWorkingDir || '').trim() || app.getPath('userData');
  try { await fs.mkdir(cwd, { recursive: true }); } catch (_) {}

  const args = buildClaudeCliArgs(payload);

  // Resume when we already own a session; otherwise mint a deterministic id so
  // the very first turn is resumable even if the CLI exits early.
  const sessionId = payload.claudeCliSessionId || randomUUID();
  args.push(payload.claudeCliSessionId ? '--resume' : '--session-id', sessionId);

  if (payload.claudeCliModel) args.push('--model', payload.claudeCliModel);
  if (payload.systemPrompt) {
    // Double quotes would need shell-specific escaping on Windows; the prompt
    // is plain prose, so normalising them costs nothing and avoids the hazard.
    args.push('--system-prompt', String(payload.systemPrompt).replace(/"/g, "'"));
  }

  const isWindows = process.platform === 'win32';
  const env = buildClaudeCliEnv(payload);
  const child = isWindows
    // `claude` is a .cmd shim on Windows and Node refuses to exec those without
    // a shell, so build one pre-quoted command line instead of an argv array.
    ? spawn([cliPath, ...args].map(quoteWinArg).join(' '), {
        cwd, env, shell: true, windowsHide: true,
      })
    : spawn(cliPath, args, { cwd, env, windowsHide: true });

  let aborted = false;
  const onAbort = () => { aborted = true; try { child.kill(); } catch (_) {} };
  signal.addEventListener('abort', onAbort, { once: true });

  // The prompt goes over stdin, never argv: documents pasted into the chat can
  // be tens of KB and Windows caps a command line at ~32k characters.
  // An EPIPE here (CLI exited before reading stdin) is emitted asynchronously
  // on the stream — a try/catch cannot see it, and an unhandled 'error' event
  // would take down the whole main process.
  child.stdin.on('error', () => {});
  try {
    child.stdin.write(payload.prompt ?? '');
    child.stdin.end();
  } catch (_) {}

  let emittedText = false;   // did we stream any delta? (drives the fallback)
  let fatal = false;         // already reported a terminal error
  let stderrTail = '';
  let buffer = '';

  const fail = (message) => {
    if (fatal) return;
    fatal = true;
    send('error', undefined, message);
    try { child.kill(); } catch (_) {}
  };

  const handleEvent = (evt) => {
    switch (evt.type) {
      case 'system':
        // The CLI retries auth failures ten times with backoff (~3 minutes of
        // silence). Surface the first one and stop, rather than making the user
        // watch a spinner that was never going to succeed.
        if (evt.subtype === 'api_retry' && (evt.error_status === 401 || evt.error_status === 403)) {
          fail(`Claude CLI authentication failed (HTTP ${evt.error_status}` +
               `${evt.error ? `: ${evt.error}` : ''}).\n\n` +
               `The CLI itself is not logged in — this is separate from the API keys in AI Settings. ` +
               `Run "claude" in a terminal and check it works, or re-run "claude setup-token".`);
          break;
        }
        // init announces the real session id — trust it over ours, since
        // --resume can hand back a different one.
        if (evt.subtype === 'init' && evt.session_id) {
          send('session', undefined, undefined, { sessionId: evt.session_id });
        }
        break;

      case 'stream_event': {
        const inner = evt.event;
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          emittedText = true;
          send('chunk', inner.delta.text);
        }
        break;
      }

      case 'assistant':
        // Complete message. With --include-partial-messages this duplicates the
        // deltas, so only use it when partials produced nothing.
        if (!emittedText) {
          const text = (evt.message?.content || [])
            .filter(b => b.type === 'text').map(b => b.text).join('');
          if (text) { emittedText = true; send('chunk', text); }
        }
        break;

      case 'result':
        if (evt.session_id) send('session', undefined, undefined, { sessionId: evt.session_id });
        if (evt.usage) {
          send('usage', undefined, undefined, {
            usage: {
              inputTokens: evt.usage.input_tokens,
              outputTokens: evt.usage.output_tokens,
              cacheCreationTokens: evt.usage.cache_creation_input_tokens,
              cacheReadTokens: evt.usage.cache_read_input_tokens,
              costUsd: evt.total_cost_usd,
            },
          });
        }
        if (!emittedText && typeof evt.result === 'string' && evt.result) {
          emittedText = true;
          send('chunk', evt.result);
        }
        if (evt.is_error) send('error', undefined, evt.result || 'Claude CLI reported an error');
        break;
    }
  };

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (data) => {
    buffer += data;
    // NDJSON: one JSON object per line, but a chunk can split mid-line.
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try { handleEvent(JSON.parse(line)); }
      catch (_) { /* non-JSON noise (banners, warnings) — ignore */ }
    }
  });

  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });

  const watchdog = setTimeout(() => {
    fail(`Claude CLI did not respond within ${CLAUDE_CLI_TIMEOUT_MS / 1000}s. ` +
         `Check that "${cliPath}" works from a terminal.`);
  }, CLAUDE_CLI_TIMEOUT_MS);

  await new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(watchdog);
      if (!aborted) {
        fail(err.code === 'ENOENT'
          ? `Claude CLI not found: "${cliPath}". Set the full path in AI Settings → Claude CLI.`
          : `Failed to start Claude CLI: ${err.message}`);
      }
      resolve();
    });

    child.on('close', (code) => {
      clearTimeout(watchdog);
      signal.removeEventListener('abort', onAbort);
      if (aborted || fatal) return resolve(); // error already reported
      if (code !== 0 && !emittedText) {
        send('error', undefined,
          stderrTail.trim() || `Claude CLI exited with code ${code}`);
      } else {
        send('done');
      }
      resolve();
    });
  });
}

async function streamBedrock(payload, signal, send) {
  const { BedrockRuntimeClient, ConverseStreamCommand } =
    require('@aws-sdk/client-bedrock-runtime');
  const { fromIni } = require('@aws-sdk/credential-providers');
  const client = new BedrockRuntimeClient({
    region: payload.bedrockRegion || 'us-east-1',
    credentials: fromIni({ profile: payload.bedrockProfile || 'default' }),
  });
  const history = (payload.history || []).map(m => ({
    role: m.role,
    content: [{ text: m.content }]
  }));
  const response = await client.send(new ConverseStreamCommand({
    modelId: payload.bedrockModelId || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    messages: [...history, { role: 'user', content: [{ text: payload.prompt }] }],
    ...(payload.systemPrompt ? { system: [{ text: payload.systemPrompt }] } : {}),
  }), { abortSignal: signal });
  for await (const event of response.stream) {
    if (signal.aborted) break;
    const text = event.contentBlockDelta?.delta?.text ?? '';
    if (text) send('chunk', text);
  }
  send('done');
}
