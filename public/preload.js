const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFile: () => ipcRenderer.invoke('select-file'),
  selectFolderOrFile: () => ipcRenderer.invoke('select-folder-or-file'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  saveFileAs: (content) => ipcRenderer.invoke('save-file-as', content),
  getDirectoryContents: (dirPath) => ipcRenderer.invoke('get-directory-contents', dirPath),
  createNewFile: (defaultPath) => ipcRenderer.invoke('create-new-file', defaultPath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath)
});
