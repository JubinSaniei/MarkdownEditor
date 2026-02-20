import {
  Component, OnInit, AfterViewInit, OnDestroy,
  ViewChild, ElementRef, NgZone
} from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from './services/electron.service';
import { FileService } from './services/file.service';
import { ThemeService } from './services/theme.service';
import { ScrollSyncService } from './services/scroll-sync.service';
import { SearchService } from './services/search.service';
import { SearchState, SearchMode, SearchTarget, SearchOptions } from './interfaces/search.interface';
import { MarkdownEditorComponent } from './components/markdown-editor/markdown-editor.component';
import { MarkdownPreviewComponent } from './components/markdown-preview/markdown-preview.component';

interface EditorTab {
  id: string;
  filePath: string | null;
  content: string;
  isDirty: boolean;
  isPreview: boolean; // temporary tab reused by single-click; promoted on dblclick or edit
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  standalone: false
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('markdownEditor') markdownEditor!: MarkdownEditorComponent;
  @ViewChild('markdownPreview') markdownPreview!: MarkdownPreviewComponent;
  @ViewChild('markdownEditor', { read: ElementRef }) editorContainer!: ElementRef;
  @ViewChild('markdownPreview', { read: ElementRef }) previewContainer!: ElementRef;
  @ViewChild('searchInput') searchInputElement!: ElementRef<HTMLInputElement>;
  @ViewChild('replaceInput') replaceInputElement!: ElementRef<HTMLInputElement>;
  @ViewChild('editorArea') editorAreaRef!: ElementRef;

  // ── Workspace ─────────────────────────────────────────────
  title = 'Markdown Editor';
  workspaceRoots: string[] = [];

  // ── Tab State ─────────────────────────────────────────────
  tabs: EditorTab[] = [];
  activeTabId: string = '';

  get activeTab(): EditorTab | null {
    return this.tabs.find(t => t.id === this.activeTabId) ?? null;
  }

  get currentFilePath(): string | null {
    return this.activeTab?.filePath ?? null;
  }

  get isDirty(): boolean {
    return this.activeTab?.isDirty ?? false;
  }

  get currentFileContent(): string {
    return this.activeTab?.content ?? '';
  }

  // ── Recent Files ──────────────────────────────────────────
  recentFiles: string[] = [];
  private readonly MAX_RECENT = 5;

  // ── View State ────────────────────────────────────────────
  isExplorerCollapsed: boolean = false;
  viewMode: 'preview' | 'edit' | 'split' = 'split';

  // ── Split Resize ──────────────────────────────────────────
  editorPaneWidth: number = 50;
  isDraggingSplit: boolean = false;
  private splitMoveHandler!: (e: MouseEvent) => void;
  private splitUpHandler!: () => void;

  // ── External Change Warning ───────────────────────────────
  showExternalChangeWarning: boolean = false;

  // ── Search State ──────────────────────────────────────────
  searchState: SearchState = {
    query: '',
    isActive: false,
    results: [],
    currentIndex: 0,
    totalMatches: 0,
    searchMode: SearchMode.PREVIEW
  };
  isReplaceVisible: boolean = false;
  replaceQuery: string = '';
  searchOptions: SearchOptions = { caseSensitive: false, wholeWord: false, useRegex: false };

  // ── Auto-save ─────────────────────────────────────────────
  autoSaveEnabled: boolean = false;
  private autoSaveIntervalMs: number = 30000;
  private autoSaveTimer: any = null;
  showAutoSaveIndicator: boolean = false;

  // ── Save Dropdown ─────────────────────────────────────────
  showSaveDropdown: boolean = false;

  // ── Save Suppression (ignore own-write events from file watcher) ──
  private readonly saveSuppressionSet = new Set<string>();

  // ── Subscriptions ─────────────────────────────────────────
  private searchSubscription!: Subscription;

  constructor(
    private electronService: ElectronService,
    private fileService: FileService,
    private themeService: ThemeService,
    private scrollSyncService: ScrollSyncService,
    private searchService: SearchService,
    private ngZone: NgZone
  ) {}

  ngOnInit() {
    this.loadSettings();
    this.themeService.setTheme(this.themeService.getCurrentTheme());

    this.searchSubscription = this.searchService.searchState.subscribe(state => {
      this.searchState = state;
      this.applySearchHighlighting();
    });

    this.updateSearchMode();

    this.electronService.onFileChanged((changedPath: string) => {
      if (this.saveSuppressionSet.has(changedPath)) return;
      if (changedPath === this.currentFilePath) {
        this.showExternalChangeWarning = true;
      }
    });

    // Open files sent by a second instance (e.g. user double-clicks another .md
    // while the app is already running — single-instance lock forwards it here).
    // NgZone.run() is required because ipcRenderer.on() fires outside Angular's
    // zone, so without it Angular never detects the state change and won't re-render.
    this.electronService.onOpenFile((filePath: string) => {
      this.ngZone.run(() => this.openFileAsNewTab(filePath));
    });
  }

  async ngAfterViewInit() {
    this.setupScrollSync();
    const lastFile = localStorage.getItem('lastOpenedFile');
    if (lastFile) {
      this.openFileByPath(lastFile);
    }
    // Open a file passed via "Open with" or command-line argument at startup
    const initFile = await this.electronService.getInitialFile();
    if (initFile) {
      this.openFileAsNewTab(initFile);
    }
  }

  ngOnDestroy() {
    this.scrollSyncService.cleanup();
    if (this.searchSubscription) this.searchSubscription.unsubscribe();
    this.stopAutoSave();
    this.electronService.removeFileChangedListener();
    for (const tab of this.tabs) {
      if (tab.filePath) this.electronService.unwatchFile(tab.filePath);
    }
    if (this.isDraggingSplit) {
      document.removeEventListener('mousemove', this.splitMoveHandler);
      document.removeEventListener('mouseup', this.splitUpHandler);
    }
  }

  // ── Dirty State ───────────────────────────────────────────

  private updateDirtyState() {
    const tab = this.activeTab;
    const fileName = tab?.filePath
      ? tab.filePath.split(/[/\\]/).pop() || 'Untitled'
      : 'Untitled';
    (window as any).__dirtyState__ = {
      isDirty: tab?.isDirty ?? false,
      filePath: tab?.filePath ?? null,
      content: tab?.content ?? '',
      fileName
    };
  }

  // ── Tab Management ────────────────────────────────────────

  // Double-click: opens a permanent tab (promotes preview if the file is already open)
  async openFileAsNewTab(filePath: string) {
    if (!filePath) return;
    const existing = this.tabs.find(t => t.filePath === filePath);
    if (existing) {
      existing.isPreview = false; // promote to permanent
      this.activateTab(existing.id);
      return;
    }
    try {
      const content = await this.fileService.readFile(filePath);
      const tab: EditorTab = {
        id: Date.now().toString(),
        filePath,
        content,
        isDirty: false,
        isPreview: false
      };
      this.tabs.push(tab);
      this.activateTab(tab.id);
      this.addToRecentFiles(filePath);
      localStorage.setItem('lastOpenedFile', filePath);
      await this.electronService.watchFile(filePath);
    } catch (_) {
      localStorage.removeItem('lastOpenedFile');
    }
  }

  activateTab(tabId: string) {
    this.activeTabId = tabId;
    this.showExternalChangeWarning = false;
    if (this.searchState.isActive) this.closeSearch();
    this.updateDirtyState();
    this.saveSettings();
    setTimeout(() => {
      this.markdownEditor?.scrollToTop();
      this.markdownPreview?.scrollToTop();
    }, 0);
  }

  closeTab(tab: EditorTab, event?: MouseEvent) {
    if (event) event.stopPropagation();
    if (tab.isDirty) {
      const confirmed = confirm(`"${this.getTabDisplayName(tab)}" has unsaved changes. Close anyway?`);
      if (!confirmed) return;
    }
    if (tab.filePath) this.electronService.unwatchFile(tab.filePath);
    const idx = this.tabs.indexOf(tab);
    this.tabs.splice(idx, 1);
    if (this.activeTabId === tab.id) {
      if (this.tabs.length > 0) {
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.activateTab(this.tabs[newIdx].id);
      } else {
        this.activeTabId = '';
        this.saveSettings();
      }
    } else {
      this.saveSettings();
    }
  }

  getTabDisplayName(tab: EditorTab): string {
    return tab.filePath ? this.getFileName(tab.filePath) : 'Untitled';
  }

  promoteTab(tab: EditorTab) {
    tab.isPreview = false;
  }

  // ── New File ──────────────────────────────────────────────

  newFile() {
    const tab: EditorTab = {
      id: Date.now().toString(),
      filePath: null,
      content: '',
      isDirty: false,
      isPreview: false
    };
    this.tabs.push(tab);
    this.activateTab(tab.id);
  }

  // ── Workspace ─────────────────────────────────────────────

  onWorkspaceOpened(root: string) {
    if (!this.workspaceRoots.includes(root)) {
      this.workspaceRoots = [...this.workspaceRoots, root];
    }
    this.saveSettings();
  }

  onWorkspaceRemoved(root: string) {
    this.workspaceRoots = this.workspaceRoots.filter(r => r !== root);
    this.saveSettings();
  }

  // ── File Open ─────────────────────────────────────────────

  // Single-click: reuse the existing preview tab, or open a new preview tab.
  // If the file is already open in a permanent tab, just activate it.
  async onFileOpened(filePath: string) {
    if (!filePath) return;

    // Already open in a permanent tab → just activate
    const permanent = this.tabs.find(t => t.filePath === filePath && !t.isPreview);
    if (permanent) {
      this.activateTab(permanent.id);
      return;
    }

    // Already open in the preview tab → just activate (no reload needed)
    const existingPreview = this.tabs.find(t => t.isPreview);
    if (existingPreview && existingPreview.filePath === filePath) {
      this.activateTab(existingPreview.id);
      return;
    }

    try {
      const content = await this.fileService.readFile(filePath);

      if (existingPreview) {
        // Reuse the existing preview tab with the new file
        if (existingPreview.filePath) await this.electronService.unwatchFile(existingPreview.filePath);
        existingPreview.filePath = filePath;
        existingPreview.content = content;
        existingPreview.isDirty = false;
        this.activateTab(existingPreview.id);
      } else {
        // No preview tab yet — create one
        const tab: EditorTab = {
          id: Date.now().toString(),
          filePath,
          content,
          isDirty: false,
          isPreview: true
        };
        this.tabs.push(tab);
        this.activateTab(tab.id);
      }

      this.addToRecentFiles(filePath);
      localStorage.setItem('lastOpenedFile', filePath);
      await this.electronService.watchFile(filePath);
    } catch (_) {}
  }

  async openFileByPath(filePath: string) {
    await this.openFileAsNewTab(filePath);
  }

  onContentChanged(content: string) {
    const tab = this.activeTab;
    if (tab) {
      tab.content = content;
      tab.isDirty = true;
      tab.isPreview = false; // editing promotes the tab to permanent
    }
    this.updateDirtyState();
  }

  // ── Save ──────────────────────────────────────────────────

  async saveFile() {
    const tab = this.activeTab;
    if (!tab) return;
    if (!tab.filePath) {
      await this.saveAsFile();
      return;
    }
    this.suppressFileChange(tab.filePath);
    const ok = await this.fileService.writeFile(tab.filePath, tab.content);
    if (ok) {
      tab.isDirty = false;
      this.updateDirtyState();
      this.flashAutoSaveIndicator();
    }
  }

  async saveAsFile() {
    const tab = this.activeTab;
    if (!tab) return;
    const result = await this.electronService.saveFileAs(tab.content);
    if (result.success && result.filePath) {
      if (tab.filePath) await this.electronService.unwatchFile(tab.filePath);
      tab.filePath = result.filePath;
      tab.isDirty = false;
      this.updateDirtyState();
      this.addToRecentFiles(result.filePath);
      localStorage.setItem('lastOpenedFile', result.filePath);
      await this.electronService.watchFile(result.filePath);
      this.flashAutoSaveIndicator();
    }
  }

  // ── File Watcher ──────────────────────────────────────────

  async reloadCurrentFile() {
    const tab = this.activeTab;
    if (!tab?.filePath) return;
    tab.content = await this.fileService.readFile(tab.filePath);
    tab.isDirty = false;
    this.showExternalChangeWarning = false;
    this.updateDirtyState();
  }

  dismissExternalChange() {
    this.showExternalChangeWarning = false;
  }

  // ── Recent Files ──────────────────────────────────────────

  addToRecentFiles(filePath: string) {
    this.recentFiles = [filePath, ...this.recentFiles.filter(f => f !== filePath)]
      .slice(0, this.MAX_RECENT);
    this.saveSettings();
  }

  onRecentFileOpened(filePath: string) {
    this.onFileOpened(filePath);
  }

  // ── Explorer & View ───────────────────────────────────────

  toggleExplorer() {
    this.isExplorerCollapsed = !this.isExplorerCollapsed;
    this.saveSettings();
  }

  setViewMode(mode: 'preview' | 'edit' | 'split') {
    this.viewMode = mode;
    if (mode === 'preview') this.isReplaceVisible = false;
    this.saveSettings();
    this.updateSearchMode();
    if (mode === 'split') {
      setTimeout(() => {
        this.setupScrollSync();
        // ViewChild refs may not exist until after the pane *ngIf creates them
        if (this.searchState.isActive) this.applySearchHighlighting();
      }, 100);
    } else {
      this.scrollSyncService.cleanup();
      // Re-apply highlighting after the pane switch so the new ViewChild picks it up
      if (this.searchState.isActive) {
        setTimeout(() => this.applySearchHighlighting(), 50);
      }
    }
  }

  // ── Split Resize ──────────────────────────────────────────

  onSplitDividerMouseDown(event: MouseEvent) {
    event.preventDefault();
    this.isDraggingSplit = true;

    this.splitMoveHandler = (e: MouseEvent) => {
      const rect = (this.editorAreaRef.nativeElement as HTMLElement).getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      this.editorPaneWidth = Math.max(15, Math.min(85, pct));
    };

    this.splitUpHandler = () => {
      this.isDraggingSplit = false;
      document.removeEventListener('mousemove', this.splitMoveHandler);
      document.removeEventListener('mouseup', this.splitUpHandler);
      this.saveSettings();
    };

    document.addEventListener('mousemove', this.splitMoveHandler);
    document.addEventListener('mouseup', this.splitUpHandler);
  }

  // ── Theme ─────────────────────────────────────────────────

  get isDarkTheme(): boolean {
    return this.themeService.getCurrentTheme() === 'dark';
  }

  toggleTheme() {
    this.themeService.toggleTheme();
  }

  // ── Auto-save ─────────────────────────────────────────────

  toggleAutoSave() {
    this.autoSaveEnabled = !this.autoSaveEnabled;
    this.saveSettings();
    if (this.autoSaveEnabled) {
      this.startAutoSave();
    } else {
      this.stopAutoSave();
    }
  }

  private startAutoSave() {
    this.stopAutoSave();
    this.autoSaveTimer = setInterval(async () => {
      const tab = this.activeTab;
      if (tab?.isDirty && tab?.filePath) {
        await this.saveFile();
      }
    }, this.autoSaveIntervalMs);
  }

  private stopAutoSave() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  private suppressFileChange(filePath: string) {
    this.saveSuppressionSet.add(filePath);
    setTimeout(() => this.saveSuppressionSet.delete(filePath), 1000);
  }

  private flashAutoSaveIndicator() {
    this.showAutoSaveIndicator = true;
    setTimeout(() => { this.showAutoSaveIndicator = false; }, 2000);
  }

  // ── Word Count ────────────────────────────────────────────

  get wordCount(): number {
    const text = this.currentFileContent.trim();
    return text ? text.split(/\s+/).length : 0;
  }

  get charCount(): number {
    return this.currentFileContent.length;
  }

  get lineCount(): number {
    if (!this.currentFileContent) return 0;
    return this.currentFileContent.split('\n').length;
  }

  // ── Helper ────────────────────────────────────────────────

  getFileName(filePath: string): string {
    return filePath.split(/[/\\]/).pop() || filePath;
  }

  // ── Save Dropdown ─────────────────────────────────────────

  toggleSaveDropdown() {
    this.showSaveDropdown = !this.showSaveDropdown;
  }

  closeSaveDropdown() {
    this.showSaveDropdown = false;
  }

  onGlobalClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.dropdown')) this.closeSaveDropdown();
    if (!target.closest('.search-overlay') && !target.closest('.search-toggle-btn')) {
      // Don't close search on click in editor area
    }
  }

  // ── Keyboard Shortcuts ────────────────────────────────────

  onGlobalKeyDown(event: KeyboardEvent) {
    // Ctrl+S: save (works everywhere including textarea)
    if (event.ctrlKey && event.key === 's') {
      event.preventDefault();
      this.saveFile();
      return;
    }

    // Ctrl+N: new file
    if (event.ctrlKey && event.key === 'n') {
      event.preventDefault();
      this.newFile();
      return;
    }

    // Ctrl+W: close active tab (works everywhere)
    if (event.ctrlKey && event.key === 'w') {
      event.preventDefault();
      if (this.activeTab) this.closeTab(this.activeTab);
      return;
    }

    // View mode shortcuts (works everywhere)
    if (event.ctrlKey && event.key === '1') { event.preventDefault(); this.setViewMode('preview'); return; }
    if (event.ctrlKey && event.key === '2') { event.preventDefault(); this.setViewMode('edit'); return; }
    if (event.ctrlKey && event.key === '3') { event.preventDefault(); this.setViewMode('split'); return; }

    const activeEl = document.activeElement as HTMLElement;
    const isInput = activeEl && (
      activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA'
    );

    if (isInput) {
      if (event.ctrlKey && event.key === 'f') { event.preventDefault(); this.toggleSearch(); return; }
      if (event.key === 'F3') { event.preventDefault(); event.shiftKey ? this.findPrevious() : this.findNext(); return; }
      if (event.key === 'Escape' && this.searchState.isActive) { this.closeSearch(); return; }
      return;
    }

    if (event.ctrlKey && event.key === 'f') { event.preventDefault(); this.toggleSearch(); return; }
    if (event.key === 'F3') { event.preventDefault(); event.shiftKey ? this.findPrevious() : this.findNext(); return; }
    if (event.key === 'Escape' && this.searchState.isActive) { this.closeSearch(); return; }
  }

  onSearchKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.shiftKey ? this.findPrevious() : this.findNext();
    } else if (event.key === 'F3') {
      event.preventDefault();
      event.shiftKey ? this.findPrevious() : this.findNext();
    } else if (event.key === 'Escape') {
      this.closeSearch();
    } else if (event.key === 'Tab' && !event.shiftKey && this.isReplaceVisible) {
      event.preventDefault();
      this.replaceInputElement?.nativeElement.focus();
    }
  }

  onReplaceKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.shiftKey ? this.replaceAll() : this.replaceOne();
    } else if (event.key === 'Escape') {
      this.closeSearch();
    }
  }

  // ── Search ────────────────────────────────────────────────

  onSearchQueryChange(query: string) {
    this.searchService.updateSearchQuery(query);
    if (query.trim()) {
      this.performSearch();
    } else {
      this.applySearchHighlighting();
    }
  }

  toggleSearch() {
    const wasActive = this.searchState.isActive;
    this.searchService.toggleSearch();
    if (!wasActive) {
      requestAnimationFrame(() => {
        this.searchInputElement?.nativeElement.focus();
        this.searchInputElement?.nativeElement.select();
      });
    }
  }

  openSearch() {
    this.searchService.openSearch();
    requestAnimationFrame(() => this.searchInputElement?.nativeElement.focus());
  }

  closeSearch() {
    this.searchService.closeSearch();
    this.isReplaceVisible = false;
    if (this.markdownEditor) this.markdownEditor.closeSearch();
    if (this.markdownPreview) this.markdownPreview.closeSearch();
  }

  toggleReplace() {
    this.isReplaceVisible = !this.isReplaceVisible;
    if (this.isReplaceVisible) {
      requestAnimationFrame(() => this.replaceInputElement?.nativeElement.focus());
    }
  }

  performSearch() {
    if (!this.currentFileContent) return;
    // Always search a single target — the content is identical for both editor
    // and preview panes. Passing two targets would double the results array,
    // corrupting the editor backdrop (overlapping span insertions) and
    // showing the wrong match count in the UI.
    this.searchService.performSearch([{ type: 'editor', content: this.currentFileContent }]);
  }

  findNext() { this.searchService.navigateNext(); }
  findPrevious() { this.searchService.navigatePrevious(); }

  // ── Replace ───────────────────────────────────────────────

  replaceOne() {
    if (!this.searchState.query || !this.searchState.totalMatches) return;
    const tab = this.activeTab;
    if (!tab) return;
    const newContent = this.searchService.replaceOne(
      tab.content, this.searchState.currentIndex, this.replaceQuery
    );
    tab.content = newContent;
    tab.isDirty = true;
    this.updateDirtyState();
    this.performSearch();
  }

  replaceAll() {
    if (!this.searchState.query || !this.searchState.totalMatches) return;
    const tab = this.activeTab;
    if (!tab) return;
    const newContent = this.searchService.replaceAll(tab.content, this.replaceQuery);
    tab.content = newContent;
    tab.isDirty = true;
    this.updateDirtyState();
    this.performSearch();
  }

  // ── Search Options ────────────────────────────────────────

  toggleSearchOption(option: 'caseSensitive' | 'wholeWord' | 'useRegex') {
    this.searchOptions = { ...this.searchOptions, [option]: !this.searchOptions[option] };
    this.searchService.updateSearchOptions(this.searchOptions);
    if (this.searchState.query) this.performSearch();
  }

  // ── Private Search Internals ──────────────────────────────

  private updateSearchMode() {
    const modeMap: Record<string, SearchMode> = {
      edit: SearchMode.EDITOR,
      preview: SearchMode.PREVIEW,
      split: SearchMode.SPLIT
    };
    this.searchService.setSearchMode(modeMap[this.viewMode] || SearchMode.PREVIEW);
  }

  private setupScrollSync() {
    if (this.viewMode === 'split' && this.editorContainer && this.previewContainer) {
      this.scrollSyncService.setupSync(this.editorContainer, this.previewContainer);
    }
  }

  private applySearchHighlighting() {
    const { query, results, currentIndex, searchMode } = this.searchState;

    if (!query) {
      this.markdownEditor?.closeSearch();
      this.markdownPreview?.closeSearch();
      return;
    }

    if (searchMode === SearchMode.EDITOR || searchMode === SearchMode.SPLIT) {
      this.markdownEditor?.highlightSearchResults(query, results, currentIndex);
    }
    if (searchMode === SearchMode.PREVIEW || searchMode === SearchMode.SPLIT) {
      this.markdownPreview?.highlightSearchResults(query, results, currentIndex);
    }
  }

  // ── Settings Persistence ──────────────────────────────────

  private loadSettings() {
    try {
      const raw = localStorage.getItem('markdownEditorSettings');
      if (!raw) return;
      const s = JSON.parse(raw);
      // Support both the new array format and the old single-root format
      this.workspaceRoots = Array.isArray(s.workspaceRoots)
        ? s.workspaceRoots
        : (s.workspaceRoot ? [s.workspaceRoot] : []);
      this.isExplorerCollapsed = s.isExplorerCollapsed || false;
      this.viewMode = s.viewMode || 'split';
      this.autoSaveEnabled = s.autoSaveEnabled || false;
      this.recentFiles = Array.isArray(s.recentFiles) ? s.recentFiles : [];
      if (typeof s.editorPaneWidth === 'number') {
        this.editorPaneWidth = Math.max(15, Math.min(85, s.editorPaneWidth));
      }
    } catch (_) {}

    if (this.autoSaveEnabled) this.startAutoSave();
  }

  private saveSettings() {
    const s = {
      workspaceRoots: this.workspaceRoots,
      isExplorerCollapsed: this.isExplorerCollapsed,
      viewMode: this.viewMode,
      autoSaveEnabled: this.autoSaveEnabled,
      recentFiles: this.recentFiles,
      editorPaneWidth: this.editorPaneWidth,
      activeTabPath: this.activeTab?.filePath ?? null,
      tabPaths: this.tabs.map(t => t.filePath).filter(Boolean)
    };
    localStorage.setItem('markdownEditorSettings', JSON.stringify(s));
  }
}
