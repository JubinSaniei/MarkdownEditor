import {
  Component, OnInit, AfterViewInit, OnDestroy,
  ViewChild, ElementRef, NgZone
} from '@angular/core';
import packageInfo from '../../package.json';
import { Subscription } from 'rxjs';
import { ElectronService } from './services/electron.service';
import { FileService } from './services/file.service';
import { ThemeService } from './services/theme.service';
import { ScrollSyncService } from './services/scroll-sync.service';
import { SearchService } from './services/search.service';
import { SearchState, SearchMode, SearchOptions } from './interfaces/search.interface';
import { AiSettingsService } from './services/ai-settings.service';
import { MarkdownEditorComponent } from './components/markdown-editor/markdown-editor.component';
import { MarkdownPreviewComponent } from './components/markdown-preview/markdown-preview.component';

interface EditorTab {
  id: string;
  filePath: string | null;
  content: string;
  isDirty: boolean;
  isPreview: boolean; // temporary tab reused by single-click; promoted on dblclick or edit
  readOnly?: boolean;
  label?: string; // overrides display name when set
}

interface EditorGroup {
  id: string;
  tabs: EditorTab[];
  activeTabId: string;
  viewMode: 'preview' | 'edit' | 'split';
  paneWidth: number; // editor pane % width within this group's split view
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  standalone: false
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {

  // ── LEFT group ViewChildren ────────────────────────────────
  @ViewChild('editorLeft') editorLeft?: MarkdownEditorComponent;
  @ViewChild('editorLeft', { read: ElementRef }) editorLeftRef?: ElementRef;
  @ViewChild('previewLeft') previewLeft?: MarkdownPreviewComponent;
  @ViewChild('previewLeft', { read: ElementRef }) previewLeftRef?: ElementRef;
  @ViewChild('groupLeftContent') groupLeftContentRef?: ElementRef;

  // ── RIGHT group ViewChildren (optional: only when 2nd group exists) ──
  @ViewChild('editorRight') editorRight?: MarkdownEditorComponent;
  @ViewChild('editorRight', { read: ElementRef }) editorRightRef?: ElementRef;
  @ViewChild('previewRight') previewRight?: MarkdownPreviewComponent;
  @ViewChild('previewRight', { read: ElementRef }) previewRightRef?: ElementRef;
  @ViewChild('groupRightContent') groupRightContentRef?: ElementRef;

  @ViewChild('searchInput') searchInputElement!: ElementRef<HTMLInputElement>;
  @ViewChild('replaceInput') replaceInputElement!: ElementRef<HTMLInputElement>;
  @ViewChild('editorArea') editorAreaRef!: ElementRef;

  // ── Backward-compat getters for ViewChild refs ─────────────
  get markdownEditor(): MarkdownEditorComponent | undefined {
    return this.activeGroupId === 'g1' ? this.editorLeft : this.editorRight;
  }
  get markdownPreview(): MarkdownPreviewComponent | undefined {
    return this.activeGroupId === 'g1' ? this.previewLeft : this.previewRight;
  }
  get editorContainer(): ElementRef | undefined {
    return this.activeGroupId === 'g1' ? this.editorLeftRef : this.editorRightRef;
  }
  get previewContainer(): ElementRef | undefined {
    return this.activeGroupId === 'g1' ? this.previewLeftRef : this.previewRightRef;
  }

  // ── Workspace ──────────────────────────────────────────────
  title = 'Markdown Editor';
  readonly appVersion: string = packageInfo.version;
  workspaceRoots: string[] = [];

  // ── Group State ────────────────────────────────────────────
  groups: EditorGroup[] = [
    { id: 'g1', tabs: [], activeTabId: '', viewMode: 'preview', paneWidth: 50 }
  ];
  activeGroupId: string = 'g1';
  groupSplitWidth: number = 50; // % width of left group when 2 groups are shown

  // ── Backward-Compat Getters (delegate to active group) ────
  get activeGroup(): EditorGroup {
    return this.groups.find(g => g.id === this.activeGroupId) ?? this.groups[0];
  }

  get tabs(): EditorTab[] {
    return this.activeGroup?.tabs ?? [];
  }

  get activeTabId(): string {
    return this.activeGroup?.activeTabId ?? '';
  }

  get activeTab(): EditorTab | null {
    return this.activeGroup?.tabs.find(t => t.id === this.activeGroup?.activeTabId) ?? null;
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

  get viewMode(): 'preview' | 'edit' | 'split' {
    return this.activeGroup?.viewMode ?? 'preview';
  }
  set viewMode(mode: 'preview' | 'edit' | 'split') {
    if (this.activeGroup) this.activeGroup.viewMode = mode;
  }

  get editorPaneWidth(): number {
    return this.activeGroup?.paneWidth ?? 50;
  }
  set editorPaneWidth(v: number) {
    if (this.activeGroup) this.activeGroup.paneWidth = v;
  }

  // ── Recent Files ──────────────────────────────────────────
  recentFiles: string[] = [];
  private readonly MAX_RECENT = 5;

  // ── View State ────────────────────────────────────────────
  isExplorerCollapsed: boolean = false;

  // ── Session Restore ───────────────────────────────────────
  private restoredTabPaths: string[] = [];       // old single-group format
  private restoredActiveTabPath: string | null = null;
  private restoredGroupsData: Array<{
    id: string;
    viewMode: 'preview' | 'edit' | 'split';
    paneWidth: number;
    tabPaths: string[];
    activeTabPath: string | null;
  }> = [];
  private restoredActiveGroupId: string = 'g1';

  // ── Split Resize ──────────────────────────────────────────
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

  // ── AI Settings ───────────────────────────────────────────
  showAiSettings: boolean = false;

  // ── AI Panel ──────────────────────────────────────────────
  showAiPanel: boolean = false;
  aiPanelWidth: number = 300;
  isDraggingAiPanel: boolean = false;

  // ── Font Size ─────────────────────────────────────────────
  fontSize: number = 13;
  private readonly FONT_SIZE_MIN = 10;
  private readonly FONT_SIZE_MAX = 28;
  private readonly FONT_SIZE_DEFAULT = 13;
  private wheelHandler!: (e: WheelEvent) => void;

  // ── Drag-and-Drop ─────────────────────────────────────────
  isDraggingFile: boolean = false;
  private dragCounter: number = 0;

  // ── Save Suppression ──────────────────────────────────────
  private readonly saveSuppressionSet = new Set<string>();

  // ── Subscriptions ─────────────────────────────────────────
  private searchSubscription!: Subscription;

  constructor(
    private electronService: ElectronService,
    private fileService: FileService,
    private themeService: ThemeService,
    private scrollSyncService: ScrollSyncService,
    private searchService: SearchService,
    private aiSettingsService: AiSettingsService,
    private ngZone: NgZone
  ) {}

  ngOnInit() {
    this.loadSettings();
    this.applyFontSize();
    this.themeService.setTheme(this.themeService.getCurrentTheme());

    this.wheelHandler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      this.ngZone.run(() => this.changeFontSize(delta));
    };
    document.addEventListener('wheel', this.wheelHandler, { passive: false });

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

    this.electronService.onOpenFile((filePath: string) => {
      this.ngZone.run(() => this.openFileAsNewTab(filePath));
    });
  }

  async ngAfterViewInit() {
    this.setupScrollSync();

    if (this.restoredGroupsData.length > 0) {
      // New multi-group format — groups were pre-created in loadSettings
      for (const groupData of this.restoredGroupsData) {
        const group = this.groups.find(g => g.id === groupData.id);
        if (!group) continue;
        for (const filePath of groupData.tabPaths) {
          try {
            const content = await this.fileService.readFile(filePath);
            const tab: EditorTab = {
              id: `${Date.now()}-${group.tabs.length}`,
              filePath, content, isDirty: false, isPreview: false
            };
            group.tabs.push(tab);
            await this.electronService.watchFile(filePath);
          } catch (_) {}
        }
        if (group.tabs.length > 0) {
          const activeTab = groupData.activeTabPath
            ? group.tabs.find(t => t.filePath === groupData.activeTabPath)
            : null;
          group.activeTabId = (activeTab ?? group.tabs[group.tabs.length - 1]).id;
        }
      }
      if (this.groups.find(g => g.id === this.restoredActiveGroupId)) {
        this.activeGroupId = this.restoredActiveGroupId;
      }
    } else if (this.restoredTabPaths.length > 0) {
      // Old single-group format migration
      const group = this.groups[0];
      for (const filePath of this.restoredTabPaths) {
        try {
          const content = await this.fileService.readFile(filePath);
          const tab: EditorTab = {
            id: `${Date.now()}-${group.tabs.length}`,
            filePath, content, isDirty: false, isPreview: false
          };
          group.tabs.push(tab);
          await this.electronService.watchFile(filePath);
        } catch (_) {}
      }
      if (group.tabs.length > 0) {
        const activeTab = this.restoredActiveTabPath
          ? group.tabs.find(t => t.filePath === this.restoredActiveTabPath)
          : null;
        group.activeTabId = (activeTab ?? group.tabs[group.tabs.length - 1]).id;
      }
    } else {
      const lastFile = localStorage.getItem('lastOpenedFile');
      if (lastFile) this.openFileByPath(lastFile);
    }

    const initFile = await this.electronService.getInitialFile();
    if (initFile) this.openFileAsNewTab(initFile);
  }

  ngOnDestroy() {
    document.removeEventListener('wheel', this.wheelHandler);
    this.scrollSyncService.cleanup();
    if (this.searchSubscription) this.searchSubscription.unsubscribe();
    this.stopAutoSave();
    this.electronService.removeFileChangedListener();
    for (const group of this.groups) {
      for (const tab of group.tabs) {
        if (tab.filePath) this.electronService.unwatchFile(tab.filePath);
      }
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

  // ── Group Management ──────────────────────────────────────

  setActiveGroup(groupId: string) {
    if (this.activeGroupId === groupId) return;
    this.activeGroupId = groupId;
    this.updateSearchMode();
    this.scrollSyncService.cleanup();
    if (this.viewMode === 'split') {
      setTimeout(() => this.setupScrollSync(), 100);
    }
  }

  addGroupRight() {
    if (this.groups.length >= 2) {
      this.setActiveGroup('g2');
      return;
    }
    this.groups.push({
      id: 'g2',
      tabs: [],
      activeTabId: '',
      viewMode: this.groups[0].viewMode,
      paneWidth: 50
    });
    this.activeGroupId = 'g2';
    this.saveSettings();
  }

  closeGroup(groupId: string) {
    const idx = this.groups.findIndex(g => g.id === groupId);
    if (idx === -1) return;
    for (const tab of this.groups[idx].tabs) {
      if (tab.filePath) this.electronService.unwatchFile(tab.filePath);
    }
    this.groups.splice(idx, 1);
    if (this.groups.length > 0) {
      this.activeGroupId = this.groups[0].id;
    }
    this.saveSettings();
  }

  moveTabToOtherGroup(tab: EditorTab, sourceGroup: EditorGroup, event?: MouseEvent) {
    if (event) event.stopPropagation();

    let targetGroup: EditorGroup;
    if (sourceGroup.id === 'g1') {
      if (this.groups.length < 2) {
        this.groups.push({
          id: 'g2',
          tabs: [],
          activeTabId: '',
          viewMode: sourceGroup.viewMode,
          paneWidth: 50
        });
      }
      targetGroup = this.groups[1];
    } else {
      targetGroup = this.groups[0];
    }

    // Remove from source
    const idx = sourceGroup.tabs.indexOf(tab);
    sourceGroup.tabs.splice(idx, 1);

    // Add to target before any early-exit cleanup
    targetGroup.tabs.push(tab);

    // Update source active tab if needed
    if (sourceGroup.activeTabId === tab.id) {
      if (sourceGroup.tabs.length > 0) {
        sourceGroup.activeTabId = sourceGroup.tabs[Math.min(idx, sourceGroup.tabs.length - 1)].id;
      } else {
        sourceGroup.activeTabId = '';
        // Remove empty right group
        if (sourceGroup.id !== 'g1') {
          const srcIdx = this.groups.findIndex(g => g.id === sourceGroup.id);
          if (srcIdx > 0) this.groups.splice(srcIdx, 1);
        }
      }
    }

    this.activateTab(tab.id);
    this.saveSettings();
  }

  getGroupActiveContent(group: EditorGroup): string {
    const activeTab = group.tabs.find(t => t.id === group.activeTabId);
    return activeTab?.content ?? '';
  }

  onGroupContentChanged(group: EditorGroup, content: string) {
    // Typing activates the group
    if (this.activeGroupId !== group.id) {
      this.activeGroupId = group.id;
    }
    const tab = group.tabs.find(t => t.id === group.activeTabId);
    if (tab) {
      if (tab.readOnly) return;
      tab.content = content;
      tab.isDirty = true;
      tab.isPreview = false;
    }
    this.updateDirtyState();
  }

  onGroupDividerMouseDown(event: MouseEvent) {
    event.preventDefault();
    this.isDraggingSplit = true;

    const moveHandler = (e: MouseEvent) => {
      const rect = (this.editorAreaRef.nativeElement as HTMLElement).getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      this.groupSplitWidth = Math.max(15, Math.min(85, pct));
    };

    const upHandler = () => {
      this.isDraggingSplit = false;
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      this.saveSettings();
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  }

  // ── Tab Management ────────────────────────────────────────

  async openFileAsNewTab(filePath: string) {
    if (!filePath) return;
    // Search all groups for existing tab
    for (const group of this.groups) {
      const existing = group.tabs.find(t => t.filePath === filePath);
      if (existing) {
        existing.isPreview = false;
        this.activateTab(existing.id);
        return;
      }
    }
    try {
      const content = await this.fileService.readFile(filePath);
      const tab: EditorTab = {
        id: Date.now().toString(),
        filePath, content, isDirty: false, isPreview: false
      };
      this.activeGroup.tabs.push(tab);
      this.activateTab(tab.id);
      this.addToRecentFiles(filePath);
      localStorage.setItem('lastOpenedFile', filePath);
      await this.electronService.watchFile(filePath);
    } catch (_) {
      localStorage.removeItem('lastOpenedFile');
    }
  }

  activateTab(tabId: string) {
    const group = this.groups.find(g => g.tabs.some(t => t.id === tabId));
    if (group) {
      this.activeGroupId = group.id;
      group.activeTabId = tabId;
    }
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
    if (tab.isDirty && !tab.readOnly) {
      const confirmed = confirm(`"${this.getTabDisplayName(tab)}" has unsaved changes. Close anyway?`);
      if (!confirmed) return;
    }
    if (tab.filePath) this.electronService.unwatchFile(tab.filePath);

    const group = this.groups.find(g => g.tabs.includes(tab));
    if (!group) return;

    const idx = group.tabs.indexOf(tab);
    group.tabs.splice(idx, 1);

    if (group.activeTabId === tab.id) {
      if (group.tabs.length > 0) {
        group.activeTabId = group.tabs[Math.min(idx, group.tabs.length - 1)].id;
        if (this.activeGroupId === group.id) {
          this.showExternalChangeWarning = false;
          this.updateDirtyState();
        }
      } else {
        group.activeTabId = '';
        // Remove empty right group
        if (group.id !== 'g1') {
          this.closeGroup(group.id);
          return;
        }
      }
    }
    this.saveSettings();
  }

  getTabDisplayName(tab: EditorTab): string {
    if (tab.label) return tab.label;
    return tab.filePath ? this.getFileName(tab.filePath) : 'Untitled';
  }

  promoteTab(tab: EditorTab) {
    tab.isPreview = false;
  }

  // ── New File ──────────────────────────────────────────────

  newFile() {
    const tab: EditorTab = {
      id: Date.now().toString(),
      filePath: null, content: '', isDirty: false, isPreview: false
    };
    this.activeGroup.tabs.push(tab);
    this.activateTab(tab.id);
  }

  // ── README ────────────────────────────────────────────────

  async openReadme() {
    for (const group of this.groups) {
      const existing = group.tabs.find(t => t.label === 'README');
      if (existing) {
        this.activateTab(existing.id);
        return;
      }
    }
    try {
      const response = await fetch('assets/README.md');
      if (!response.ok) return;
      const content = (await response.text()).replace(/\(src\/assets\//g, '(assets/');
      const tab: EditorTab = {
        id: Date.now().toString(),
        filePath: null,
        content,
        isDirty: false,
        isPreview: false,
        readOnly: true,
        label: 'README'
      };
      this.activeGroup.tabs.push(tab);
      this.activateTab(tab.id);
      if (this.viewMode === 'edit') {
        this.setViewMode('preview');
      }
    } catch (_) {}
  }

  getGroupActiveTab(group: EditorGroup): EditorTab | null {
    return group.tabs.find(t => t.id === group.activeTabId) ?? null;
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

  async onFileOpened(filePath: string) {
    if (!filePath) return;

    // Already open in a permanent tab in any group → just activate
    for (const group of this.groups) {
      const permanent = group.tabs.find(t => t.filePath === filePath && !t.isPreview);
      if (permanent) {
        this.activateTab(permanent.id);
        return;
      }
    }

    // Use active group's preview slot
    const existingPreview = this.activeGroup.tabs.find(t => t.isPreview);
    if (existingPreview && existingPreview.filePath === filePath) {
      this.activateTab(existingPreview.id);
      return;
    }

    try {
      const content = await this.fileService.readFile(filePath);

      if (existingPreview) {
        if (existingPreview.filePath) await this.electronService.unwatchFile(existingPreview.filePath);
        existingPreview.filePath = filePath;
        existingPreview.content = content;
        existingPreview.isDirty = false;
        this.activateTab(existingPreview.id);
      } else {
        const tab: EditorTab = {
          id: Date.now().toString(),
          filePath, content, isDirty: false, isPreview: true
        };
        this.activeGroup.tabs.push(tab);
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

  // ── Save ──────────────────────────────────────────────────

  async saveFile() {
    const tab = this.activeTab;
    if (!tab || tab.readOnly) return;
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
    if (!tab || tab.readOnly) return;
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

  clearRecentFiles() {
    this.recentFiles = [];
    this.saveSettings();
  }

  // ── Explorer & View ───────────────────────────────────────

  toggleExplorer() {
    this.isExplorerCollapsed = !this.isExplorerCollapsed;
    this.saveSettings();
  }

  setViewMode(mode: 'preview' | 'edit' | 'split') {
    this.viewMode = mode; // setter delegates to activeGroup
    if (mode === 'preview') this.isReplaceVisible = false;
    this.saveSettings();
    this.updateSearchMode();
    if (mode === 'split') {
      setTimeout(() => {
        this.setupScrollSync();
        if (this.searchState.isActive) this.applySearchHighlighting();
      }, 100);
    } else {
      this.scrollSyncService.cleanup();
      if (this.searchState.isActive) {
        setTimeout(() => this.applySearchHighlighting(), 50);
      }
    }
  }

  // ── Split Resize (within-group editor/preview) ────────────

  onSplitDividerMouseDown(event: MouseEvent, groupId: string) {
    event.preventDefault();
    this.isDraggingSplit = true;
    const group = this.groups.find(g => g.id === groupId);
    const containerRef = groupId === 'g1' ? this.groupLeftContentRef : this.groupRightContentRef;

    this.splitMoveHandler = (e: MouseEvent) => {
      if (!group || !containerRef) return;
      const rect = (containerRef.nativeElement as HTMLElement).getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      group.paneWidth = Math.max(15, Math.min(85, pct));
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

  // ── Font Size ─────────────────────────────────────────────

  changeFontSize(delta: number) {
    this.fontSize = Math.max(this.FONT_SIZE_MIN, Math.min(this.FONT_SIZE_MAX, this.fontSize + delta));
    this.applyFontSize();
    this.saveSettings();
    setTimeout(() => this.markdownEditor?.refreshBackdropStyles(), 0);
  }

  resetFontSize() {
    this.fontSize = this.FONT_SIZE_DEFAULT;
    this.applyFontSize();
    this.saveSettings();
    setTimeout(() => this.markdownEditor?.refreshBackdropStyles(), 0);
  }

  private applyFontSize() {
    document.documentElement.style.setProperty('--editor-font-size', `${this.fontSize}px`);
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

  openAiSettings(): void  { this.showAiSettings = true; }
  closeAiSettings(): void { this.showAiSettings = false; }

  toggleAiPanel(): void { this.showAiPanel = !this.showAiPanel; }
  closeAiPanel(): void  { this.showAiPanel = false; }

  onAiPanelDividerMouseDown(event: MouseEvent) {
    event.preventDefault();
    this.isDraggingAiPanel = true;
    const startX = event.clientX;
    const startWidth = this.aiPanelWidth;

    const moveHandler = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      this.aiPanelWidth = Math.max(220, Math.min(640, startWidth + delta));
    };

    const upHandler = () => {
      this.isDraggingAiPanel = false;
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      this.saveSettings();
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  }

  insertAiText(text: string): void {
    const tab = this.activeTab;
    if (!tab || tab.readOnly) return;
    const separator = tab.content.length > 0 && !tab.content.endsWith('\n') ? '\n\n' : '';
    tab.content = tab.content + separator + text;
    tab.isDirty = true;
    tab.isPreview = false;
    this.updateDirtyState();
  }

  toggleSaveDropdown() {
    this.showSaveDropdown = !this.showSaveDropdown;
  }

  closeSaveDropdown() {
    this.showSaveDropdown = false;
  }

  onGlobalClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.dropdown')) this.closeSaveDropdown();
  }

  onDragEnter(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter++;
    if (event.dataTransfer?.types.includes('Files')) {
      this.isDraggingFile = true;
    }
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter--;
    if (this.dragCounter <= 0) {
      this.dragCounter = 0;
      this.isDraggingFile = false;
    }
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter = 0;
    this.isDraggingFile = false;
    if (!event.dataTransfer?.files.length) return;
    for (const file of Array.from(event.dataTransfer.files)) {
      if (!file.name.toLowerCase().endsWith('.md')) continue;
      const filePath = this.electronService.getPathForFile(file);
      if (filePath) this.openFileAsNewTab(filePath);
    }
  }

  // ── Keyboard Shortcuts ────────────────────────────────────

  onGlobalKeyDown(event: KeyboardEvent) {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      this.toggleAiPanel();
      return;
    }
    if (event.ctrlKey && event.key === 's') {
      event.preventDefault();
      this.saveFile();
      return;
    }
    if (event.ctrlKey && event.key === 'n') {
      event.preventDefault();
      this.newFile();
      return;
    }
    if (event.ctrlKey && event.key === 'w') {
      event.preventDefault();
      if (this.activeTab) this.closeTab(this.activeTab);
      return;
    }
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
      event.stopPropagation();
      event.shiftKey ? this.findPrevious() : this.findNext();
    } else if (event.key === 'F3') {
      event.preventDefault();
      event.stopPropagation();
      event.shiftKey ? this.findPrevious() : this.findNext();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
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
      this.markdownEditor?.clearSearchHighlights();
      this.markdownPreview?.clearSearchHighlights();
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

      this.workspaceRoots = Array.isArray(s.workspaceRoots)
        ? s.workspaceRoots
        : (s.workspaceRoot ? [s.workspaceRoot] : []);
      this.isExplorerCollapsed = s.isExplorerCollapsed || false;
      this.autoSaveEnabled = s.autoSaveEnabled || false;
      this.recentFiles = Array.isArray(s.recentFiles) ? s.recentFiles : [];
      if (typeof s.fontSize === 'number') {
        this.fontSize = Math.max(this.FONT_SIZE_MIN, Math.min(this.FONT_SIZE_MAX, s.fontSize));
      }
      if (typeof s.groupSplitWidth === 'number') {
        this.groupSplitWidth = Math.max(15, Math.min(85, s.groupSplitWidth));
      }
      if (typeof s.aiPanelWidth === 'number') {
        this.aiPanelWidth = Math.max(220, Math.min(640, s.aiPanelWidth));
      }

      if (Array.isArray(s.groups) && s.groups.length > 0) {
        // New multi-group format
        this.restoredGroupsData = s.groups.map((g: any) => ({
          id: g.id || 'g1',
          viewMode: (['preview', 'edit', 'split'].includes(g.viewMode) ? g.viewMode : 'preview') as 'preview' | 'edit' | 'split',
          paneWidth: typeof g.paneWidth === 'number' ? Math.max(15, Math.min(85, g.paneWidth)) : 50,
          tabPaths: Array.isArray(g.tabPaths) ? g.tabPaths.filter((p: any) => typeof p === 'string' && p) : [],
          activeTabPath: typeof g.activeTabPath === 'string' ? g.activeTabPath : null,
        }));

        // Pre-create groups with persisted viewMode/paneWidth
        this.groups = [];
        for (const gd of this.restoredGroupsData) {
          this.groups.push({ id: gd.id, tabs: [], activeTabId: '', viewMode: gd.viewMode, paneWidth: gd.paneWidth });
        }
        this.restoredActiveGroupId = typeof s.activeGroupId === 'string' ? s.activeGroupId : 'g1';
        this.activeGroupId = this.restoredActiveGroupId;
      } else {
        // Old single-group format migration
        const vm = (['preview', 'edit', 'split'].includes(s.viewMode) ? s.viewMode : 'preview') as 'preview' | 'edit' | 'split';
        this.groups[0].viewMode = vm;
        if (typeof s.editorPaneWidth === 'number') {
          this.groups[0].paneWidth = Math.max(15, Math.min(85, s.editorPaneWidth));
        }
        this.restoredTabPaths = Array.isArray(s.tabPaths)
          ? s.tabPaths.filter((p: any) => typeof p === 'string' && p)
          : [];
        this.restoredActiveTabPath = typeof s.activeTabPath === 'string' ? s.activeTabPath : null;
      }
    } catch (_) {}

    if (this.autoSaveEnabled) this.startAutoSave();
  }

  private saveSettings() {
    const s = {
      workspaceRoots: this.workspaceRoots,
      isExplorerCollapsed: this.isExplorerCollapsed,
      autoSaveEnabled: this.autoSaveEnabled,
      recentFiles: this.recentFiles,
      fontSize: this.fontSize,
      groupSplitWidth: this.groupSplitWidth,
      aiPanelWidth: this.aiPanelWidth,
      activeGroupId: this.activeGroupId,
      groups: this.groups.map(g => ({
        id: g.id,
        viewMode: g.viewMode,
        paneWidth: g.paneWidth,
        tabPaths: g.tabs.map(t => t.filePath).filter(Boolean),
        activeTabPath: g.tabs.find(t => t.id === g.activeTabId)?.filePath ?? null,
      }))
    };
    localStorage.setItem('markdownEditorSettings', JSON.stringify(s));
  }
}
