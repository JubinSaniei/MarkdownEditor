import { Component, Input, Output, EventEmitter, OnInit, OnChanges, SimpleChanges, OnDestroy, HostListener } from '@angular/core';
import { FileService } from '../../services/file.service';
import { ElectronService } from '../../services/electron.service';

export interface WorkspaceFile {
  name: string;
  path: string;
  lastModified?: Date;
}

export interface FolderGroup {
  folderName: string;      // Just the folder name (e.g., "Documents")
  folderPath: string;      // Full folder path (e.g., "/Users/john/Documents")
  files: WorkspaceFile[];
  expanded: boolean;
}

/**
 * Simple file-only workspace manager component:
 * - Add individual .md files to workspace
 * - Remove files from workspace
 * - Select files from workspace list
 * - Create new files
 * - No folder management - files only
 */
@Component({
  selector: 'app-file-explorer',
  templateUrl: './file-explorer.component.html',
  styleUrls: ['./file-explorer.component.scss'],
  standalone: false
})
export class FileExplorerComponent implements OnInit, OnChanges, OnDestroy {
  @Input() workspaceFiles: string[] = []; // Array of file paths instead of folder paths
  @Output() fileSelected = new EventEmitter<string>();
  @Output() fileOpened = new EventEmitter<string>();
  @Output() fileAdded = new EventEmitter<string>();
  @Output() fileRemoved = new EventEmitter<string>();
  @Output() newFileCreated = new EventEmitter<{ filePath: string; content: string }>();
  @Output() fileDeleted = new EventEmitter<string>();

  files: WorkspaceFile[] = [];
  folderGroups: FolderGroup[] = [];
  public isLoading: boolean = false;
  public selectedFilePath: string | null = null;
  private loadTimeout: any;
  private clickTimeout: any;

  constructor(
    private fileService: FileService,
    private electronService: ElectronService
  ) {}

  ngOnInit() {
    this.loadWorkspaceFiles();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['workspaceFiles']) {
      // Debounce the loading to prevent rapid successive calls
      if (this.loadTimeout) {
        clearTimeout(this.loadTimeout);
      }
      this.loadTimeout = setTimeout(() => {
        this.loadWorkspaceFiles();
      }, 100);
    }
  }

  /**
   * Opens file dialog to select a .md file and adds it to workspace
   */
  async addFile() {
    const result = await this.electronService.selectFile();
    if (result && this.fileService.isValidMarkdownPath(result)) {
      this.fileAdded.emit(result);
    } else if (result) {
      console.warn('Selected file is not a markdown file:', result);
      // Could show user message here
    }
  }

  /**
   * Creates a new markdown file and adds it to workspace
   */
  async createNewFile() {
    const result = await this.fileService.createNewFile();
    
    if (result.success && result.filePath && result.content !== undefined) {
      // Emit events for the new file
      this.newFileCreated.emit({ filePath: result.filePath, content: result.content });
      this.fileAdded.emit(result.filePath);
      
      // Refresh the workspace to show the new file
      this.refreshWorkspace();
    } else if (result.error && !result.cancelled) {
      console.error('Failed to create new file:', result.error);
    }
  }

  /**
   * Removes a file from workspace (does not delete the actual file)
   */
  removeFileFromWorkspace(filePath: string, event: Event) {
    event.stopPropagation();
    this.fileRemoved.emit(filePath);
  }

  /**
   * Deletes the actual file from disk and removes it from workspace
   */
  async deleteFile(filePath: string, event: Event) {
    event.stopPropagation();
    
    const result = await this.fileService.deleteFile(filePath);
    
    if (result.success) {
      this.fileDeleted.emit(filePath);
      this.fileRemoved.emit(filePath); // Also remove from workspace
      this.refreshWorkspace();
    } else if (result.error && !result.cancelled) {
      console.error('Failed to delete file:', result.error);
    }
  }

  /**
   * Refreshes the workspace file list
   */
  refreshWorkspace(): void {
    // Clear any pending timeout
    if (this.loadTimeout) {
      clearTimeout(this.loadTimeout);
    }
    
    // Store current selection
    const selectedPath = this.selectedFilePath;
    
    // Reload files
    this.loadWorkspaceFiles().then(() => {
      // Restore selection if file still exists
      if (selectedPath && this.files.some(f => f.path === selectedPath)) {
        this.selectedFilePath = selectedPath;
      } else {
        this.selectedFilePath = null;
      }
    });
  }

  /**
   * Loads workspace files and gets their metadata
   */
  private async loadWorkspaceFiles(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;

    this.files = [];

    if (!this.workspaceFiles || this.workspaceFiles.length === 0) {
      this.isLoading = false;
      this.selectedFilePath = null;
      return;
    }

    // Process each file in workspace
    for (const filePath of this.workspaceFiles) {
      try {
        // Verify file still exists and get basic info
        const fileName = filePath.split(/[/\\]/).pop() || filePath;
        
        // Only include markdown files
        if (this.fileService.isValidMarkdownPath(filePath)) {
          this.files.push({
            name: fileName,
            path: filePath
          });
        }
      } catch (error) {
        console.warn(`Could not access workspace file: ${filePath}`, error);
      }
    }

    // Sort files alphabetically
    this.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    // Group files by parent directory
    this.groupFilesByFolder();

    this.isLoading = false;
  }

  /**
   * Groups files by their parent directories
   */
  private groupFilesByFolder(): void {
    const folderMap = new Map<string, FolderGroup>();

    // Group files by parent directory
    for (const file of this.files) {
      const folderPath = this.getParentDirectory(file.path);
      const folderName = this.getFolderName(folderPath);

      if (!folderMap.has(folderPath)) {
        folderMap.set(folderPath, {
          folderName: folderName,
          folderPath: folderPath,
          files: [],
          expanded: false // Start collapsed by default
        });
      }

      folderMap.get(folderPath)!.files.push(file);
    }

    // Convert map to array and sort
    this.folderGroups = Array.from(folderMap.values());
    
    // Sort folder groups by folder name
    this.folderGroups.sort((a, b) => 
      a.folderName.localeCompare(b.folderName, undefined, { sensitivity: 'base' })
    );

    // Sort files within each folder
    this.folderGroups.forEach(group => {
      group.files.sort((a, b) => 
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    });
  }

  /**
   * Gets the parent directory path from a file path
   */
  private getParentDirectory(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    parts.pop(); // Remove filename
    return parts.join('/') || '/';
  }

  /**
   * Gets just the folder name (last part of path) from a directory path
   */
  private getFolderName(folderPath: string): string {
    if (folderPath === '/' || folderPath === '') return 'Root';
    
    const parts = folderPath.replace(/\\/g, '/').split('/').filter(part => part.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : 'Root';
  }

  /**
   * Toggles the expanded state of a folder group
   */
  toggleFolderGroup(group: FolderGroup): void {
    group.expanded = !group.expanded;
  }

  /**
   * Handles file selection with single-click behavior
   */
  onFileClick(file: WorkspaceFile, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    // Single-click to select and open file immediately
    this.openFile(file);
  }

  /**
   * Selects a file (visual feedback only)
   */
  private selectFile(file: WorkspaceFile): void {
    this.selectedFilePath = file.path;
    this.fileSelected.emit(file.path);
  }

  /**
   * Opens a file for editing
   */
  private openFile(file: WorkspaceFile): void {
    this.selectedFilePath = file.path;
    this.fileOpened.emit(file.path);
  }

  /**
   * Checks if a file is currently selected
   */
  isFileSelected(file: WorkspaceFile): boolean {
    return this.selectedFilePath === file.path;
  }

  /**
   * Clears the current selection
   */
  clearSelection(): void {
    this.selectedFilePath = null;
  }

  /**
   * Handles keyboard navigation for files
   */
  onFileKeyDown(file: WorkspaceFile, event: KeyboardEvent): void {
    switch (event.key) {
      case 'Enter':
      case ' ': // Space key
        event.preventDefault();
        this.openFile(file);
        break;
      case 'Delete':
        event.preventDefault();
        this.removeFileFromWorkspace(file.path, event);
        break;
    }
  }

  /**
   * Handles keyboard navigation for the file list container
   */
  onFileListKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.clearSelection();
      event.preventDefault();
    }
  }

  /**
   * Gets ARIA label for files
   */
  getFileAriaLabel(file: WorkspaceFile): string {
    const selected = this.isFileSelected(file) ? ', selected' : '';
    return `Markdown file: ${file.name}${selected}`;
  }

  /**
   * Gets a shortened display name for files with long paths
   */
  getDisplayName(file: WorkspaceFile): string {
    return file.name;
  }

  /**
   * Gets the directory path for display
   */
  getFileDirectory(file: WorkspaceFile): string {
    const parts = file.path.replace(/\\/g, '/').split('/');
    parts.pop(); // Remove filename
    return parts.join('/') || '/';
  }

  /**
   * Track by function for Angular *ngFor performance - files
   */
  trackByPath(index: number, file: WorkspaceFile): string {
    return file.path;
  }

  /**
   * Track by function for folder groups
   */
  trackByFolderPath(index: number, group: FolderGroup): string {
    return group.folderPath;
  }

  ngOnDestroy(): void {
    if (this.loadTimeout) {
      clearTimeout(this.loadTimeout);
    }
    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
    }
  }
}