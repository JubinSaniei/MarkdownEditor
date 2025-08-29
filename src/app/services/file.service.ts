import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
  expanded?: boolean;
}

interface CacheEntry {
  data: FileTreeNode[];
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class FileService {
  private readonly MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
  private readonly CACHE_DURATION_MS = 60000; // 1 minute cache
  private readonly fileTreeCache = new Map<string, CacheEntry>();

  constructor(private electronService: ElectronService) { }

  async readFile(filePath: string): Promise<string> {
    return await this.electronService.readFile(filePath);
  }

  async writeFile(filePath: string, content: string): Promise<boolean> {
    return await this.electronService.writeFile(filePath, content);
  }

  async saveFileAs(content: string): Promise<boolean> {
    return await this.electronService.saveFileAs(content);
  }

  async createNewFile(defaultPath?: string): Promise<{ success: boolean; filePath?: string; content?: string; error?: string; cancelled?: boolean }> {
    const result = await this.electronService.createNewFile(defaultPath);
    
    // Invalidate cache for the parent directory if file creation succeeded
    if (result.success && result.filePath) {
      const parentDir = this.getParentDirectory(result.filePath);
      this.invalidateCache(parentDir);
    }
    
    return result;
  }

  async deleteFile(filePath: string): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
    const result = await this.electronService.deleteFile(filePath);
    
    // Invalidate cache for the parent directory if file deletion succeeded
    if (result.success) {
      const parentDir = this.getParentDirectory(filePath);
      this.invalidateCache(parentDir);
    }
    
    return result;
  }

  async getDirectoryTree(dirPath: string): Promise<FileTreeNode[]> {
    // Check cache first for better performance
    const cached = this.fileTreeCache.get(dirPath);
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION_MS) {
      return cached.data.map(node => ({ ...node })); // Return shallow copies
    }

    try {
      const contents = await this.electronService.getDirectoryContents(dirPath);
      const tree = this.buildFileTree(contents, dirPath);
      
      // Update cache with fresh data
      this.fileTreeCache.set(dirPath, {
        data: tree,
        timestamp: Date.now()
      });
      
      return tree;
    } catch (error) {
      console.error(`Failed to get directory tree for ${dirPath}:`, error);
      return [];
    }
  }

  private buildFileTree(contents: any[], basePath: string): FileTreeNode[] {
    const tree: FileTreeNode[] = [];
    
    for (const item of contents) {
      const node: FileTreeNode = {
        name: item.name,
        path: item.path,
        isDirectory: item.isDirectory,
        expanded: false
      };

      if (item.isDirectory) {
        node.children = [];
        tree.push(node);
      } else if (this.isMarkdownFile(item.name)) {
        // Double-check that it's a markdown file (backend should have already filtered)
        tree.push(node);
      }
    }

    return this.sortNodes(tree);
  }

  /**
   * Sorts nodes with directories first, then files, both in alphabetical order
   */
  private sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.sort((a, b) => {
      // Directories come first
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      
      // Within same type, sort alphabetically (case-insensitive)
      return a.name.localeCompare(b.name, undefined, { 
        sensitivity: 'base',
        numeric: true // Handle numbers in filenames correctly
      });
    });
  }

  private isMarkdownFile(fileName: string): boolean {
    const lowerName = fileName.toLowerCase();
    return this.MARKDOWN_EXTENSIONS.some(ext => lowerName.endsWith(ext));
  }

  /**
   * Gets the parent directory path from a file path
   */
  private getParentDirectory(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    parts.pop(); // Remove the filename
    return parts.join('/');
  }

  /**
   * Invalidates cache for a specific directory
   */
  invalidateCache(dirPath: string): void {
    this.fileTreeCache.delete(dirPath);
  }

  /**
   * Clears all cached directory trees
   */
  clearCache(): void {
    this.fileTreeCache.clear();
  }

  /**
   * Gets cache statistics for debugging
   */
  getCacheStats(): { size: number, entries: string[], oldestEntry?: Date } {
    const entries = Array.from(this.fileTreeCache.entries());
    const oldestTimestamp = entries.length > 0 ? 
      Math.min(...entries.map(([, entry]) => entry.timestamp)) : null;
    
    return {
      size: this.fileTreeCache.size,
      entries: entries.map(([path]) => path),
      oldestEntry: oldestTimestamp ? new Date(oldestTimestamp) : undefined
    };
  }

  /**
   * Validates if a path represents a markdown file
   */
  isValidMarkdownPath(filePath: string): boolean {
    if (!filePath) return false;
    const fileName = filePath.split(/[/\\]/).pop() || '';
    return this.isMarkdownFile(fileName);
  }

  /**
   * Gets file extension from a file path
   */
  getFileExtension(filePath: string): string {
    const fileName = filePath.split(/[/\\]/).pop() || '';
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 ? fileName.substring(dotIndex) : '';
  }

  /**
   * Gets filename without extension
   */
  getFileNameWithoutExtension(filePath: string): string {
    const fileName = filePath.split(/[/\\]/).pop() || '';
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName;
  }
}
