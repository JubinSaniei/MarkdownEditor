import { Injectable } from '@angular/core';

declare global {
  interface Window {
    electronAPI: any;
  }
}

@Injectable({
  providedIn: 'root'
})
export class ElectronService {

  get isElectron(): boolean {
    return !!(window && window.electronAPI);
  }

  // --- Dialogs ---

  async selectFolder(): Promise<string | null> {
    return this.isElectron ? await window.electronAPI.selectFolder() : null;
  }

  async selectFile(): Promise<string | null> {
    return this.isElectron ? await window.electronAPI.selectFile() : null;
  }

  async selectMultipleFiles(): Promise<string[]> {
    return this.isElectron ? await window.electronAPI.selectMultipleFiles() : [];
  }

  async selectFolderOrFile(): Promise<{ path: string; isDirectory: boolean } | null> {
    return this.isElectron ? await window.electronAPI.selectFolderOrFile() : null;
  }

  // --- File Read / Write ---

  async readFile(filePath: string): Promise<string> {
    return this.isElectron ? await window.electronAPI.readFile(filePath) : '';
  }

  async writeFile(filePath: string, content: string): Promise<boolean> {
    return this.isElectron ? await window.electronAPI.writeFile(filePath, content) : false;
  }

  async saveFileAs(content: string): Promise<{ success: boolean; filePath?: string; cancelled?: boolean }> {
    if (this.isElectron) return await window.electronAPI.saveFileAs(content);
    return { success: false };
  }

  // --- Directory Tree ---

  async getDirectoryContents(dirPath: string): Promise<any[]> {
    return this.isElectron ? await window.electronAPI.getDirectoryContents(dirPath) : [];
  }

  // --- Create / Delete / Rename ---

  async createNewFile(defaultPath?: string): Promise<{ success: boolean; filePath?: string; content?: string; error?: string; cancelled?: boolean }> {
    if (this.isElectron) return await window.electronAPI.createNewFile(defaultPath);
    return { success: false, error: 'Electron not available' };
  }

  async createFileAtPath(filePath: string, content: string = ''): Promise<{ success: boolean; filePath?: string; error?: string }> {
    if (this.isElectron) return await window.electronAPI.createFileAtPath(filePath, content);
    return { success: false, error: 'Electron not available' };
  }

  async createFolderAtPath(folderPath: string): Promise<{ success: boolean; folderPath?: string; error?: string }> {
    if (this.isElectron) return await window.electronAPI.createFolderAtPath(folderPath);
    return { success: false, error: 'Electron not available' };
  }

  async renamePath(oldPath: string, newPath: string): Promise<{ success: boolean; newPath?: string; error?: string }> {
    if (this.isElectron) return await window.electronAPI.renamePath(oldPath, newPath);
    return { success: false, error: 'Electron not available' };
  }

  async deleteFile(filePath: string): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
    if (this.isElectron) return await window.electronAPI.deleteFile(filePath);
    return { success: false, error: 'Electron not available' };
  }

  async deletePath(itemPath: string): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
    if (this.isElectron) return await window.electronAPI.deletePath(itemPath);
    return { success: false, error: 'Electron not available' };
  }

  // --- File Watcher ---

  async watchFile(filePath: string): Promise<boolean> {
    return this.isElectron ? await window.electronAPI.watchFile(filePath) : false;
  }

  async unwatchFile(filePath: string): Promise<boolean> {
    return this.isElectron ? await window.electronAPI.unwatchFile(filePath) : false;
  }

  onFileChanged(callback: (filePath: string) => void): void {
    if (this.isElectron) window.electronAPI.onFileChanged(callback);
  }

  removeFileChangedListener(): void {
    if (this.isElectron) window.electronAPI.removeFileChangedListener();
  }
}
