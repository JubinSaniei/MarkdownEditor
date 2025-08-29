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
  
  constructor() { }

  get isElectron(): boolean {
    return !!(window && window.electronAPI);
  }

  async selectFolder(): Promise<string | null> {
    if (this.isElectron) {
      return await window.electronAPI.selectFolder();
    }
    return null;
  }

  async selectFile(): Promise<string | null> {
    if (this.isElectron) {
      return await window.electronAPI.selectFile();
    }
    return null;
  }

  async selectMultipleFiles(): Promise<string[]> {
    if (this.isElectron) {
      return await window.electronAPI.selectMultipleFiles();
    }
    return [];
  }

  async selectFolderOrFile(): Promise<{ path: string; isDirectory: boolean } | null> {
    if (this.isElectron) {
      return await window.electronAPI.selectFolderOrFile();
    }
    return null;
  }

  async readFile(filePath: string): Promise<string> {
    if (this.isElectron) {
      return await window.electronAPI.readFile(filePath);
    }
    return '';
  }

  async writeFile(filePath: string, content: string): Promise<boolean> {
    if (this.isElectron) {
      return await window.electronAPI.writeFile(filePath, content);
    }
    return false;
  }

  async saveFileAs(content: string): Promise<boolean> {
    if (this.isElectron) {
      return await window.electronAPI.saveFileAs(content);
    }
    return false;
  }

  async getDirectoryContents(dirPath: string): Promise<any[]> {
    if (this.isElectron) {
      return await window.electronAPI.getDirectoryContents(dirPath);
    }
    return [];
  }

  async createNewFile(defaultPath?: string): Promise<{ success: boolean; filePath?: string; content?: string; error?: string; cancelled?: boolean }> {
    if (this.isElectron) {
      return await window.electronAPI.createNewFile(defaultPath);
    }
    return { success: false, error: 'Electron not available' };
  }

  async deleteFile(filePath: string): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
    if (this.isElectron) {
      return await window.electronAPI.deleteFile(filePath);
    }
    return { success: false, error: 'Electron not available' };
  }
}
