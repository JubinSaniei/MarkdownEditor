const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File dialogs
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFile: () => ipcRenderer.invoke('select-file'),
  selectMultipleFiles: () => ipcRenderer.invoke('select-multiple-files'),
  selectFolderOrFile: () => ipcRenderer.invoke('select-folder-or-file'),

  // File read/write
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  saveFileAs: (content) => ipcRenderer.invoke('save-file-as', content),

  // Directory tree
  getDirectoryContents: (dirPath) => ipcRenderer.invoke('get-directory-contents', dirPath),

  // Create / delete / rename
  createNewFile: (defaultPath) => ipcRenderer.invoke('create-new-file', defaultPath),
  createFileAtPath: (filePath, content) => ipcRenderer.invoke('create-file-at-path', filePath, content),
  createFolderAtPath: (folderPath) => ipcRenderer.invoke('create-folder-at-path', folderPath),
  renamePath: (oldPath, newPath) => ipcRenderer.invoke('rename-path', oldPath, newPath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  deletePath: (itemPath) => ipcRenderer.invoke('delete-path', itemPath),

  // File watcher
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.removeAllListeners('file-changed');
    ipcRenderer.on('file-changed', (_, filePath) => callback(filePath));
  },
  removeFileChangedListener: () => ipcRenderer.removeAllListeners('file-changed'),

  // Directory watcher
  watchDirectory: (dirPath) => ipcRenderer.invoke('watch-directory', dirPath),
  unwatchDirectory: (dirPath) => ipcRenderer.invoke('unwatch-directory', dirPath),
  onDirectoryChanged: (callback) => {
    ipcRenderer.removeAllListeners('directory-changed');
    ipcRenderer.on('directory-changed', (_, dirPath) => callback(dirPath));
  },
  removeDirectoryChangedListener: () => ipcRenderer.removeAllListeners('directory-changed'),

  // Open-with / CLI file argument
  getInitialFile: () => ipcRenderer.invoke('get-initial-file'),
  onOpenFile: (callback) => {
    ipcRenderer.removeAllListeners('open-file');
    ipcRenderer.on('open-file', (_, filePath) => callback(filePath));
  },

  // Drag-and-drop file path resolution (Electron 32+)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Open a URL in the default system browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // AI key management
  aiKeySet: (provider, key) => ipcRenderer.invoke('ai-key-set', provider, key),
  aiKeyGet: (provider) => ipcRenderer.invoke('ai-key-get', provider),
  aiKeyDelete: (provider) => ipcRenderer.invoke('ai-key-delete', provider),
  aiKeyStatus: () => ipcRenderer.invoke('ai-key-status'),

  // AI streaming
  aiStreamStart: (payload) => ipcRenderer.send('ai-stream-start', payload),
  aiStreamCancel: (requestId) => ipcRenderer.invoke('ai-stream-cancel', requestId),
  onAiStreamChunk: (callback) => {
    ipcRenderer.removeAllListeners('ai-stream-chunk');
    ipcRenderer.on('ai-stream-chunk', (_, data) => callback(data));
  },
  removeAiStreamChunkListener: () => ipcRenderer.removeAllListeners('ai-stream-chunk'),
});
