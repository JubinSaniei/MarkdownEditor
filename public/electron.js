const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { net } = require('electron');

let mainWindow;

// ── Window state persistence ──────────────────────────────────
function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const data = fsSync.readFileSync(getWindowStatePath(), 'utf-8');
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

function saveWindowState(win) {
  try {
    fsSync.writeFileSync(getWindowStatePath(), JSON.stringify(win.getBounds()), 'utf-8');
  } catch (_) {}
}

// File watcher state
const fileWatchers = new Map();
const changeTimers = new Map();

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
  for (const port of commonPorts) {
    if (await checkAngularApp(port)) return port;
  }
  return 4200;
}

async function createWindow() {
  const winState = loadWindowState();
  const winOptions = {
    width: winState?.width || 1300,
    height: winState?.height || 800,
    minWidth: 800,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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

  // Unsaved changes handler on close
  mainWindow.on('close', async (event) => {
    event.preventDefault();
    try {
      const dirtyState = await mainWindow.webContents.executeJavaScript('window.__dirtyState__ || null');
      if (!dirtyState || !dirtyState.isDirty) {
        saveWindowState(mainWindow);
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
          try { await fs.writeFile(dirtyState.filePath, dirtyState.content, 'utf-8'); } catch (e) {}
        }
        saveWindowState(mainWindow);
        mainWindow.destroy();
      } else if (result.response === 1) {
        saveWindowState(mainWindow);
        mainWindow.destroy();
      }
      // response === 2: Cancel — keep window open
    } catch (err) {
      saveWindowState(mainWindow);
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
    // Check file doesn't already exist
    try {
      await fs.access(filePath);
      return { success: false, error: 'File already exists' };
    } catch (_) { /* file doesn't exist, good */ }

    await fs.writeFile(filePath, content, 'utf-8');
    return { success: true, filePath };
  } catch (error) {
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
    const watcher = fsSync.watch(filePath, () => {
      if (changeTimers.has(filePath)) clearTimeout(changeTimers.get(filePath));
      changeTimers.set(filePath, setTimeout(() => {
        changeTimers.delete(filePath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('file-changed', filePath);
        }
      }, 500));
    });
    watcher.on('error', () => fileWatchers.delete(filePath));
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
  if (changeTimers.has(filePath)) {
    clearTimeout(changeTimers.get(filePath));
    changeTimers.delete(filePath);
  }
  return true;
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
