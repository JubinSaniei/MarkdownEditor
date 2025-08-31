import { Component, OnInit, AfterViewInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from './services/electron.service';
import { FileService } from './services/file.service';
import { ThemeService } from './services/theme.service';
import { ScrollSyncService } from './services/scroll-sync.service';
import { SearchService } from './services/search.service';
import { SearchState, SearchMode, SearchTarget } from './interfaces/search.interface';
import { FileExplorerComponent } from './components/file-explorer/file-explorer.component';
import { MarkdownEditorComponent } from './components/markdown-editor/markdown-editor.component';
import { MarkdownPreviewComponent } from './components/markdown-preview/markdown-preview.component';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  standalone: false
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild(FileExplorerComponent) fileExplorer!: FileExplorerComponent;
  @ViewChild('markdownEditor') markdownEditor!: MarkdownEditorComponent;
  @ViewChild('markdownPreview') markdownPreview!: MarkdownPreviewComponent;
  @ViewChild('searchInput') searchInputElement!: ElementRef<HTMLInputElement>;
  
  // ViewChild references for scroll sync containers
  @ViewChild('markdownEditor', { read: ElementRef }) editorContainer!: ElementRef;
  @ViewChild('markdownPreview', { read: ElementRef }) previewContainer!: ElementRef;
  
  title = 'Markdown Editor';
  currentFilePath: string | null = null;
  currentFileContent: string = '';
  workspaceFiles: string[] = [];
  isExplorerCollapsed: boolean = false;
  viewMode: 'preview' | 'edit' | 'split' = 'preview';
  
  
  // Save dropdown functionality
  showSaveDropdown: boolean = false;

  // Search state management
  searchState: SearchState = {
    query: '',
    isActive: false,
    results: [],
    currentIndex: 0,
    totalMatches: 0,
    searchMode: SearchMode.PREVIEW
  };

  // Subscriptions for cleanup
  private searchSubscription!: Subscription;

  constructor(
    private electronService: ElectronService,
    private fileService: FileService,
    private themeService: ThemeService,
    private scrollSyncService: ScrollSyncService,
    private searchService: SearchService
  ) {}

  ngOnInit() {
    this.loadWorkspaceSettings();
    // Ensure theme is properly applied on component initialization
    this.themeService.setTheme(this.themeService.getCurrentTheme());
    
    // Subscribe to search state changes
    this.searchSubscription = this.searchService.searchState.subscribe(state => {
      this.searchState = state;
      // Apply highlighting when state changes (but don't trigger new search)
      this.applySearchHighlighting();
    });
    
    // Set initial search mode based on current view mode
    this.updateSearchMode();
  }

  ngAfterViewInit() {
    // Setup scroll sync for split mode if components are available
    this.setupScrollSync();
  }

  /**
   * Setup scroll synchronization using the new ScrollSyncService
   * CRITICAL: This ensures both editor and preview scroll together in split mode
   */
  private setupScrollSync() {
    if (this.viewMode === 'split' && this.editorContainer && this.previewContainer) {
      console.log('Setting up scroll sync for split mode');
      this.scrollSyncService.setupSync(this.editorContainer, this.previewContainer);
    }
  }

  /**
   * Update search mode based on current view mode
   */
  private updateSearchMode() {
    let searchMode: SearchMode;
    
    switch (this.viewMode) {
      case 'edit':
        searchMode = SearchMode.EDITOR;
        break;
      case 'preview':
        searchMode = SearchMode.PREVIEW;
        break;
      case 'split':
        searchMode = SearchMode.SPLIT;
        break;
      default:
        searchMode = SearchMode.PREVIEW;
    }
    
    this.searchService.setSearchMode(searchMode);
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
    
    // Update search mode when view changes
    this.updateSearchMode();
    
    // Setup scroll sync when switching to split mode
    if (this.viewMode === 'split') {
      // Use setTimeout to ensure DOM is ready
      setTimeout(() => this.setupScrollSync(), 100);
    } else {
      // Cleanup scroll sync when leaving split mode
      this.scrollSyncService.cleanup();
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

  onMultipleFilesAdded(filePaths: string[]) {
    // Add files to workspace efficiently (handles both single and multiple files)
    const newFiles = filePaths.filter(filePath => !this.workspaceFiles.includes(filePath));
    
    if (newFiles.length > 0) {
      // Add all new files at once to trigger ngOnChanges only once
      this.workspaceFiles = [...this.workspaceFiles, ...newFiles];
      this.saveWorkspaceSettings();
      
      // Single refresh for all files
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
    else if (event.key === 'Escape' && this.searchState.isActive) {
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

  /**
   * Handle search query changes - now uses SearchService
   */
  onSearchQueryChange(query: string) {
    this.searchService.updateSearchQuery(query);
    
    // Perform search immediately for this query
    if (query.trim()) {
      this.performSearch();
    } else {
      // Clear search if query is empty
      this.applySearchHighlighting();
    }
  }

  /**
   * Toggle search visibility - now uses SearchService
   */
  toggleSearch() {
    this.searchService.toggleSearch();
  }

  /**
   * Open search - now uses SearchService
   */
  openSearch() {
    this.searchService.openSearch();
    // Use requestAnimationFrame instead of setTimeout to avoid zone.js issues
    requestAnimationFrame(() => {
      if (this.searchInputElement) {
        this.searchInputElement.nativeElement.focus();
      }
    });
  }

  /**
   * Close search - now uses SearchService
   */
  closeSearch() {
    this.searchService.closeSearch();
    
    // Clear search in child components
    if (this.markdownEditor) {
      this.markdownEditor.closeSearch();
    }
    if (this.markdownPreview) {
      this.markdownPreview.closeSearch();
    }
  }

  /**
   * Perform search using SearchService - handles all modes
   */
  performSearch() {
    if (!this.currentFileContent) {
      return;
    }

    const targets: SearchTarget[] = [];

    // Create search targets based on current view mode
    switch (this.searchState.searchMode) {
      case SearchMode.EDITOR:
        targets.push({
          type: 'editor',
          content: this.currentFileContent
        });
        break;
      
      case SearchMode.PREVIEW:
        targets.push({
          type: 'preview', 
          content: this.currentFileContent
        });
        break;
      
      case SearchMode.SPLIT:
        // CRITICAL: Search in BOTH editor and preview in split mode
        targets.push({
          type: 'editor',
          content: this.currentFileContent
        });
        targets.push({
          type: 'preview',
          content: this.currentFileContent
        });
        break;
    }

    // Perform search using SearchService
    this.searchService.performSearch(targets);
    
    // Apply highlighting to visible components
    this.applySearchHighlighting();
  }

  /**
   * Apply search highlighting to the appropriate components
   */
  private applySearchHighlighting() {
    const query = this.searchState.query;
    const results = this.searchState.results;
    const currentIndex = this.searchState.currentIndex;

    if (!query) {
      // Clear highlights
      if (this.markdownEditor) {
        this.markdownEditor.closeSearch();
      }
      if (this.markdownPreview) {
        this.markdownPreview.closeSearch();
      }
      return;
    }

    // Apply highlighting based on current mode
    switch (this.searchState.searchMode) {
      case SearchMode.EDITOR:
        if (this.markdownEditor) {
          this.markdownEditor.highlightSearchResults(query, results, currentIndex);
        }
        break;
      
      case SearchMode.PREVIEW:
        if (this.markdownPreview) {
          this.markdownPreview.highlightSearchResults(query, results, currentIndex);
        }
        break;
      
      case SearchMode.SPLIT:
        // Highlight in both components
        if (this.markdownEditor) {
          this.markdownEditor.highlightSearchResults(query, results, currentIndex);
        }
        if (this.markdownPreview) {
          this.markdownPreview.highlightSearchResults(query, results, currentIndex);
        }
        break;
    }
  }

  /**
   * Navigate to next search result - now uses SearchService
   */
  findNext() {
    this.searchService.navigateNext();
    this.applySearchHighlighting();
  }

  /**
   * Navigate to previous search result - now uses SearchService
   */
  findPrevious() {
    this.searchService.navigatePrevious();
    this.applySearchHighlighting();
  }

  /**
   * Cleanup when component is destroyed
   */
  ngOnDestroy() {
    // Cleanup scroll sync
    this.scrollSyncService.cleanup();
    
    // Cleanup subscriptions
    if (this.searchSubscription) {
      this.searchSubscription.unsubscribe();
    }
  }
}
