import { Component, OnInit, AfterViewInit, ViewChild, ElementRef } from '@angular/core';
import { ElectronService } from './services/electron.service';
import { FileService } from './services/file.service';
import { ThemeService } from './services/theme.service';
import { FileExplorerComponent } from './components/file-explorer/file-explorer.component';
import { MarkdownEditorComponent } from './components/markdown-editor/markdown-editor.component';
import { MarkdownPreviewComponent } from './components/markdown-preview/markdown-preview.component';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  standalone: false
})
export class AppComponent implements OnInit, AfterViewInit {
  @ViewChild(FileExplorerComponent) fileExplorer!: FileExplorerComponent;
  @ViewChild('markdownEditor') markdownEditor!: MarkdownEditorComponent;
  @ViewChild('markdownPreview') markdownPreview!: MarkdownPreviewComponent;
  @ViewChild('searchInput') searchInputElement!: ElementRef<HTMLInputElement>;
  
  title = 'Markdown Editor';
  currentFilePath: string | null = null;
  currentFileContent: string = '';
  workspaceFiles: string[] = [];
  isExplorerCollapsed: boolean = false;
  viewMode: 'preview' | 'edit' | 'split' = 'preview';
  
  // Search functionality
  showSearch: boolean = false;
  searchQuery: string = '';
  currentMatch: number = 0;
  totalMatches: number = 0;
  
  // Save dropdown functionality
  showSaveDropdown: boolean = false;

  constructor(
    private electronService: ElectronService,
    private fileService: FileService,
    private themeService: ThemeService
  ) {}

  ngOnInit() {
    this.loadWorkspaceSettings();
    // Ensure theme is properly applied on component initialization
    this.themeService.setTheme(this.themeService.getCurrentTheme());
  }

  ngAfterViewInit() {
    this.setupScrollListeners();
  }

  private setupScrollListeners() {
    // Set up direct scroll listeners on actual scrollable elements
    setTimeout(() => {
      const editorTextarea = document.querySelector('.editor textarea') as HTMLElement;
      const previewContent = document.querySelector('.preview .preview-content') as HTMLElement;
      
      if (editorTextarea) {
        editorTextarea.addEventListener('scroll', (e) => this.handleDirectScroll(e, 'editor'));
      }
      
      if (previewContent) {
        previewContent.addEventListener('scroll', (e) => this.handleDirectScroll(e, 'preview'));
      }
    }, 100);
  }

  private handleDirectScroll(event: Event, sourceType: 'editor' | 'preview') {
    if (this.viewMode !== 'split') return;
    
    const sourceElement = event.target as HTMLElement;
    let targetElement: HTMLElement | null = null;
    
    if (sourceType === 'editor') {
      targetElement = document.querySelector('.preview .preview-content') as HTMLElement;
    } else {
      targetElement = document.querySelector('.editor textarea') as HTMLElement;
    }
    
    if (!targetElement || !sourceElement) return;
    
    // Calculate scroll percentage
    const maxScrollTop = Math.max(1, sourceElement.scrollHeight - sourceElement.clientHeight);
    const scrollPercentage = sourceElement.scrollTop / maxScrollTop;
    
    // Apply to target
    const targetMaxScrollTop = Math.max(0, targetElement.scrollHeight - targetElement.clientHeight);
    const targetScrollTop = scrollPercentage * targetMaxScrollTop;
    
    // Temporarily disable the target's scroll listener to prevent loops
    targetElement.style.pointerEvents = 'none';
    targetElement.scrollTop = targetScrollTop;
    
    setTimeout(() => {
      if (targetElement) {
        targetElement.style.pointerEvents = '';
      }
    }, 10);
  }

  toggleExplorer() {
    this.isExplorerCollapsed = !this.isExplorerCollapsed;
    this.saveWorkspaceSettings();
  }
  toggleViewMode() {
    if (this.viewMode === 'preview') {
      this.viewMode = 'edit';
    } else if (this.viewMode === 'edit') {
      this.viewMode = 'split';
    } else {
      this.viewMode = 'preview';
    }
    this.saveWorkspaceSettings();
    
    // Re-setup scroll listeners when switching to split mode
    if (this.viewMode === 'split') {
      setTimeout(() => this.setupScrollListeners(), 100);
    }
  }
  get viewModeIcon(): string {
    switch (this.viewMode) {
      case 'preview': return '👁';
      case 'edit': return '✎';
      case 'split': return '↔';
      default: return '';
    }
  }

  get themeIcon(): string {
    return this.themeService.getCurrentTheme() === 'dark' ? '☀' : '🌙';
  }

  toggleTheme() {
    this.themeService.toggleTheme();
  }

  toggleSaveDropdown() {
    this.showSaveDropdown = !this.showSaveDropdown;
  }

  closeSaveDropdown() {
    this.showSaveDropdown = false;
  }

  onFileSelected(filePath: string) {
    // File is selected (single-click) - just update current path for visual feedback
    // Note: This doesn't open the file, just selects it
    // Opening happens on double-click via onFileOpened
  }

  onFileOpened(filePath: string) {
    // File is opened for editing (double-click or Enter key)
    this.currentFilePath = filePath;
    this.fileService.readFile(filePath).then((content: string) => {
      this.currentFileContent = content;
    });
  }

  onContentChanged(content: string) {
    this.currentFileContent = content;
  }

  onFileAdded(filePath: string) {
    // File added to workspace
    if (!this.workspaceFiles.includes(filePath)) {
      // Create a new array reference to trigger ngOnChanges
      this.workspaceFiles = [...this.workspaceFiles, filePath];
      this.saveWorkspaceSettings();
      
      // Refresh the workspace
      setTimeout(() => {
        if (this.fileExplorer) {
          this.fileExplorer.refreshWorkspace();
        }
      }, 50);
    }
  }

  onFileRemoved(filePath: string) {
    const index = this.workspaceFiles.indexOf(filePath);
    if (index !== -1) {
      // Create a new array reference to trigger ngOnChanges
      this.workspaceFiles = this.workspaceFiles.filter(file => file !== filePath);
      this.saveWorkspaceSettings();
      
      // If the removed file is currently open, clear the editor
      if (this.currentFilePath === filePath) {
        this.currentFilePath = null;
        this.currentFileContent = '';
      }
      
      // Refresh the workspace
      setTimeout(() => {
        if (this.fileExplorer) {
          this.fileExplorer.refreshWorkspace();
        }
      }, 50);
    }
  }

  onNewFileCreated(event: { filePath: string; content: string }) {
    // Open the newly created file in the editor and add to workspace
    this.currentFilePath = event.filePath;
    this.currentFileContent = event.content;
    
    // Add to workspace if not already there
    if (!this.workspaceFiles.includes(event.filePath)) {
      this.workspaceFiles = [...this.workspaceFiles, event.filePath];
      this.saveWorkspaceSettings();
    }
    
    // Refresh the workspace
    setTimeout(() => {
      if (this.fileExplorer) {
        this.fileExplorer.refreshWorkspace();
      }
    }, 100);
  }

  onFileDeleted(filePath: string) {
    // Remove from workspace and clear editor if currently open
    this.onFileRemoved(filePath);
  }

  async saveFile() {
    if (this.currentFilePath) {
      await this.fileService.writeFile(this.currentFilePath, this.currentFileContent);
    }
  }

  async saveAsFile() {
    await this.fileService.saveFileAs(this.currentFileContent);
  }

  private loadWorkspaceSettings() {
    const settings = localStorage.getItem('markdownEditorSettings');
    if (settings) {
      const parsed = JSON.parse(settings);
      // Handle migration from folder-based to file-based workspace
      if (parsed.workspaceFolders && !parsed.workspaceFiles) {
        // Migration: clear old folder-based settings
        this.workspaceFiles = [];
      } else {
        // Load file-based workspace, remove duplicates
        const files = parsed.workspaceFiles || [];
        this.workspaceFiles = Array.from(new Set(files.filter((f: any) => typeof f === 'string'))) as string[];
      }
      this.isExplorerCollapsed = parsed.isExplorerCollapsed || false;
      this.viewMode = parsed.viewMode || 'preview';
    }
  }

  private saveWorkspaceSettings() {
    const settings = {
      workspaceFiles: this.workspaceFiles,
      isExplorerCollapsed: this.isExplorerCollapsed,
      viewMode: this.viewMode
    };
    localStorage.setItem('markdownEditorSettings', JSON.stringify(settings));
  }

  syncScroll(event: Event) {
    if (this.viewMode !== 'split') return; // Only sync in split mode
    
    const target = event.target as HTMLElement;
    
    // Determine which panel is scrolling
    const isEditor = target.closest('.editor') !== null;
    const isPreview = target.closest('.preview') !== null;
    
    if (!isEditor && !isPreview) return;
    
    // Get the scrolling element
    const scrollingElement = target;
    
    // Find the other panel to sync to
    const otherSelector = isEditor ? '.preview' : '.editor';
    const otherPanelContainer = document.querySelector(otherSelector) as HTMLElement;
    
    if (!otherPanelContainer) return;
    
    // Find the scrollable element in the other panel
    let otherScrollableElement: HTMLElement | null = null;
    
    if (isEditor) {
      // For preview panel, find the scrollable content
      otherScrollableElement = otherPanelContainer.querySelector('.preview-content') as HTMLElement;
      if (!otherScrollableElement) {
        otherScrollableElement = otherPanelContainer;
      }
    } else {
      // For editor panel, find the textarea
      otherScrollableElement = otherPanelContainer.querySelector('textarea') as HTMLElement;
      if (!otherScrollableElement) {
        otherScrollableElement = otherPanelContainer;
      }
    }
    
    if (!otherScrollableElement) return;
    
    // Calculate and apply scroll synchronization
    const scrollPercentage = scrollingElement.scrollTop / Math.max(1, scrollingElement.scrollHeight - scrollingElement.clientHeight);
    const targetScrollTop = scrollPercentage * Math.max(0, otherScrollableElement.scrollHeight - otherScrollableElement.clientHeight);
    
    // Prevent infinite loop by temporarily removing scroll listeners
    otherScrollableElement.style.pointerEvents = 'none';
    otherScrollableElement.scrollTop = targetScrollTop;
    
    // Re-enable after a short delay
    setTimeout(() => {
      if (otherScrollableElement) {
        otherScrollableElement.style.pointerEvents = '';
      }
    }, 10);
  }

  onGlobalClick(event: MouseEvent) {
    // Close dropdown if clicking outside
    const target = event.target as HTMLElement;
    if (!target.closest('.dropdown')) {
      this.closeSaveDropdown();
    }
  }

  // Search functionality
  onGlobalKeyDown(event: KeyboardEvent) {
    // Skip if a search input or text input is currently focused
    const activeElement = document.activeElement as HTMLElement;
    if (activeElement && (
      activeElement.classList.contains('search-input') || 
      (activeElement as HTMLInputElement).type === 'search' ||
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA'
    )) {
      // Only allow Ctrl+F and F3 keys when in input fields
      if (event.ctrlKey && event.key === 'f') {
        event.preventDefault();
        this.toggleSearch();
        return;
      } else if (event.key === 'F3') {
        // Allow F3 search navigation even when in input fields
      } else {
        return; // Skip other global shortcuts when in input fields
      }
    }

    // Ctrl+F to open search
    if (event.ctrlKey && event.key === 'f') {
      event.preventDefault();
      this.toggleSearch();
    }
    // F3 for next, Shift+F3 for previous
    else if (event.key === 'F3') {
      event.preventDefault();
      if (event.shiftKey) {
        this.findPrevious();
      } else {
        this.findNext();
      }
    }
    // Escape to close search
    else if (event.key === 'Escape' && this.showSearch) {
      this.closeSearch();
    }
  }

  onSearchKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        this.findPrevious();
      } else {
        this.findNext();
      }
    } else if (event.key === 'F3') {
      event.preventDefault();
      if (event.shiftKey) {
        this.findPrevious();
      } else {
        this.findNext();
      }
    } else if (event.key === 'Escape') {
      this.closeSearch();
    }
  }

  onSearchQueryChange() {
    this.performSearch();
  }

  toggleSearch() {
    if (this.showSearch) {
      this.closeSearch();
    } else {
      this.openSearch();
    }
  }

  openSearch() {
    this.showSearch = true;
    setTimeout(() => {
      if (this.searchInputElement) {
        this.searchInputElement.nativeElement.focus();
      }
    }, 100);
  }

  closeSearch() {
    this.showSearch = false;
    this.searchQuery = '';
    this.currentMatch = 0;
    this.totalMatches = 0;
    
    // Clear search in child components
    if (this.markdownEditor) {
      this.markdownEditor.closeSearch();
    }
    if (this.markdownPreview) {
      this.markdownPreview.closeSearch();
    }
  }

  performSearch() {
    this.currentMatch = 0;
    this.totalMatches = 0;

    if (!this.searchQuery || !this.currentFileContent) {
      return;
    }

    // Delegate search to active components
    if (this.viewMode === 'edit' && this.markdownEditor) {
      this.markdownEditor.searchQuery = this.searchQuery;
      this.markdownEditor.performSearch(); // Don't highlight during typing
      this.currentMatch = this.markdownEditor.currentMatch;
      this.totalMatches = this.markdownEditor.totalMatches;
    } else if (this.viewMode === 'preview' && this.markdownPreview) {
      this.markdownPreview.searchQuery = this.searchQuery;
      this.markdownPreview.performSearch();
      this.currentMatch = this.markdownPreview.currentMatch;
      this.totalMatches = this.markdownPreview.totalMatches;
    } else if (this.viewMode === 'split') {
      // In split mode, search in the editor
      if (this.markdownEditor) {
        this.markdownEditor.searchQuery = this.searchQuery;
        this.markdownEditor.performSearch(); // Don't highlight during typing
        this.currentMatch = this.markdownEditor.currentMatch;
        this.totalMatches = this.markdownEditor.totalMatches;
      }
    }
  }

  findNext() {
    if (this.viewMode === 'edit' && this.markdownEditor) {
      this.markdownEditor.findNext();
      this.currentMatch = this.markdownEditor.currentMatch;
    } else if (this.viewMode === 'preview' && this.markdownPreview) {
      this.markdownPreview.findNext();
      this.currentMatch = this.markdownPreview.currentMatch;
    } else if (this.viewMode === 'split' && this.markdownEditor) {
      this.markdownEditor.findNext();
      this.currentMatch = this.markdownEditor.currentMatch;
    }
  }

  findPrevious() {
    if (this.viewMode === 'edit' && this.markdownEditor) {
      this.markdownEditor.findPrevious();
      this.currentMatch = this.markdownEditor.currentMatch;
    } else if (this.viewMode === 'preview' && this.markdownPreview) {
      this.markdownPreview.findPrevious();
      this.currentMatch = this.markdownPreview.currentMatch;
    } else if (this.viewMode === 'split' && this.markdownEditor) {
      this.markdownEditor.findPrevious();
      this.currentMatch = this.markdownEditor.currentMatch;
    }
  }
}
