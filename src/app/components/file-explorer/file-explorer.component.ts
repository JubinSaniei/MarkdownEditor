import {
  Component, Input, Output, EventEmitter, OnChanges, SimpleChanges,
  OnDestroy, HostListener, ElementRef, ChangeDetectorRef, NgZone
} from '@angular/core';
import { ElectronService } from '../../services/electron.service';

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileTreeNode[] | null; // null = not yet loaded
  expanded: boolean;
  isRenaming: boolean;
  renameValue: string;
  pendingNew: { type: 'file' | 'folder'; name: string } | null;
  loading: boolean;
}

interface RootEntry {
  path: string;
  nodes: FileTreeNode[];
  expanded: boolean;
  loading: boolean;
  pendingNew: { type: 'file' | 'folder'; name: string } | null;
}

interface ContextMenu {
  visible: boolean;
  x: number;
  y: number;
  node: FileTreeNode | null;
}

@Component({
  selector: 'app-file-explorer',
  templateUrl: './file-explorer.component.html',
  styleUrls: ['./file-explorer.component.scss'],
  standalone: false
})
export class FileExplorerComponent implements OnChanges, OnDestroy {
  @Input() workspaceRoots: string[] = [];
  @Input() recentFiles: string[] = [];
  @Input() selectedPath: string | null = null;
  @Output() fileOpened = new EventEmitter<string>();
  @Output() fileDoubleClicked = new EventEmitter<string>();
  @Output() workspaceOpened = new EventEmitter<string>();
  @Output() workspaceRemoved = new EventEmitter<string>();
  @Output() recentFileOpened = new EventEmitter<string>();
  @Output() recentFilesCleared = new EventEmitter<void>();

  workspaces: RootEntry[] = [];
  private clickTimer: any = null;
  recentExpanded: boolean = true;

  searchActive = false;
  searchQuery = '';
  searchResults: Array<{ name: string; path: string }> = [];
  searchLoading = false;
  private searchDebounce: any = null;

  contextMenu: ContextMenu = { visible: false, x: 0, y: 0, node: null };

  constructor(
    private electronService: ElectronService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
    private hostRef: ElementRef
  ) {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes['workspaceRoots']) {
      const newRoots: string[] = this.workspaceRoots || [];
      // Remove workspaces no longer in the list
      this.workspaces = this.workspaces.filter(ws => newRoots.includes(ws.path));
      // Add workspaces that are new
      for (const rootPath of newRoots) {
        if (!this.workspaces.find(ws => ws.path === rootPath)) {
          const ws: RootEntry = { path: rootPath, nodes: [], expanded: true, loading: false, pendingNew: null };
          this.workspaces.push(ws);
          this.loadWorkspace(ws);
        }
      }
    }
    if (changes['selectedPath'] && this.selectedPath) {
      this.revealPath(this.selectedPath);
    }
  }

  ngOnDestroy() {
    document.removeEventListener('click', this.closeContextMenuBound);
    if (this.clickTimer) clearTimeout(this.clickTimer);
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
  }

  // ── Tree Loading ─────────────────────────────────────────────

  async loadWorkspace(ws: RootEntry) {
    ws.loading = true;
    try {
      const contents = await this.electronService.getDirectoryContents(ws.path);
      ws.nodes = this.buildNodes(contents);
    } catch (_) {
      ws.nodes = [];
    }
    ws.loading = false;
  }

  private buildNodes(items: any[]): FileTreeNode[] {
    return items
      .filter(item => item.isDirectory || this.isMarkdown(item.name))
      .map(item => ({
        name: item.name,
        path: item.path,
        isDirectory: item.isDirectory,
        children: item.isDirectory ? null : undefined as any,
        expanded: false,
        isRenaming: false,
        renameValue: '',
        pendingNew: null,
        loading: false
      }));
  }

  async toggleNode(node: FileTreeNode) {
    if (!node.isDirectory) return;
    if (!node.expanded && node.children === null) {
      node.loading = true;
      try {
        const contents = await this.electronService.getDirectoryContents(node.path);
        node.children = this.buildNodes(contents);
      } catch (_) {
        node.children = [];
      }
      node.loading = false;
    }
    node.expanded = !node.expanded;
  }

  async refreshNode(node: FileTreeNode) {
    if (!node.isDirectory) return;
    try {
      const contents = await this.electronService.getDirectoryContents(node.path);
      node.children = this.buildNodes(contents);
    } catch (_) {}
  }

  // ── Workspace Management ─────────────────────────────────────

  async openFolder() {
    const folderPath = await this.electronService.selectFolder();
    if (folderPath) {
      this.workspaceOpened.emit(folderPath);
    }
  }

  removeWorkspace(ws: RootEntry) {
    this.workspaceRemoved.emit(ws.path);
  }

  // ── Open File ────────────────────────────────────────────────

  openFile(node: FileTreeNode) {
    if (node.isDirectory) {
      this.toggleNode(node);
      return;
    }
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
      return; // double-click will handle it via openFileNewTab
    }
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.selectedPath = node.path;
      this.fileOpened.emit(node.path);
    }, 350);
  }

  openFileNewTab(node: FileTreeNode) {
    if (node.isDirectory) return;
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.selectedPath = node.path;
    this.fileDoubleClicked.emit(node.path);
  }

  clearRecents(event: MouseEvent) {
    event.stopPropagation();
    this.recentFilesCleared.emit();
  }

  openRecentFile(filePath: string) {
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
      return; // double-click will handle it via openRecentFileNewTab
    }
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.selectedPath = filePath;
      this.recentFileOpened.emit(filePath);
    }, 350);
  }

  openRecentFileNewTab(filePath: string) {
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.selectedPath = filePath;
    this.fileDoubleClicked.emit(filePath);
  }

  // ── Rename ───────────────────────────────────────────────────

  startRename(node: FileTreeNode) {
    node.isRenaming = true;
    node.renameValue = node.name;
    this.closeContextMenu();
    setTimeout(() => {
      const input = this.hostRef.nativeElement.querySelector('.rename-input');
      if (input) { input.focus(); input.select(); }
    }, 50);
  }

  async applyRename(node: FileTreeNode) {
    const newName = node.renameValue.trim();
    if (!newName || newName === node.name) {
      node.isRenaming = false;
      return;
    }
    const dir = node.path.replace(/[/\\][^/\\]+$/, '');
    const sep = node.path.includes('\\') ? '\\' : '/';
    const newPath = dir + sep + newName;

    const result = await this.electronService.renamePath(node.path, newPath);
    if (result.success) {
      if (!node.isDirectory && this.selectedPath === node.path) {
        this.selectedPath = newPath;
        this.fileOpened.emit(newPath);
      }
      node.path = newPath;
      node.name = newName;
    }
    node.isRenaming = false;
  }

  cancelRename(node: FileTreeNode) {
    node.isRenaming = false;
  }

  onRenameKeyDown(event: KeyboardEvent, node: FileTreeNode) {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); this.applyRename(node); }
    if (event.key === 'Escape') { this.cancelRename(node); }
  }

  // ── Create File / Folder inside a node ───────────────────────

  startNewFile(parentNode: FileTreeNode | null) {
    if (!parentNode) return;
    if (!parentNode.expanded) parentNode.expanded = true;
    if (parentNode.children === null) parentNode.children = [];
    parentNode.pendingNew = { type: 'file', name: '' };
    this.closeContextMenu();
    setTimeout(() => {
      const input = this.hostRef.nativeElement.querySelector('.new-item-input');
      if (input) input.focus();
    }, 50);
  }

  startNewFolder(parentNode: FileTreeNode | null) {
    if (!parentNode) return;
    if (!parentNode.expanded) parentNode.expanded = true;
    if (parentNode.children === null) parentNode.children = [];
    parentNode.pendingNew = { type: 'folder', name: '' };
    this.closeContextMenu();
    setTimeout(() => {
      const input = this.hostRef.nativeElement.querySelector('.new-item-input');
      if (input) input.focus();
    }, 50);
  }

  async confirmNewItem(parentNode: FileTreeNode) {
    if (!parentNode.pendingNew) return;
    const rawName = parentNode.pendingNew.name.trim();
    if (!rawName) {
      parentNode.pendingNew = null;
      return;
    }
    const sep = parentNode.path.includes('\\') ? '\\' : '/';
    const newPath = parentNode.path + sep + rawName;

    let result: any;
    if (parentNode.pendingNew.type === 'file') {
      const defaultContent = rawName.endsWith('.md') ? '# ' + rawName.replace(/\.md$/, '') + '\n\n' : '';
      result = await this.electronService.createFileAtPath(newPath, defaultContent);
    } else {
      result = await this.electronService.createFolderAtPath(newPath);
    }
    parentNode.pendingNew = null;

    if (result.success) {
      await this.refreshNode(parentNode);
      if (result.filePath) {
        this.selectedPath = result.filePath;
        this.fileOpened.emit(result.filePath);
      }
    }
  }

  cancelNewItem(parentNode: FileTreeNode) {
    parentNode.pendingNew = null;
  }

  onNewItemKeyDown(event: KeyboardEvent, parentNode: FileTreeNode) {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); this.confirmNewItem(parentNode); }
    if (event.key === 'Escape') { this.cancelNewItem(parentNode); }
  }

  // ── Create at workspace root ──────────────────────────────────

  startNewFileAtRoot() {
    if (this.workspaces.length === 1) this.startNewFileInWorkspace(this.workspaces[0]);
  }

  startNewFolderAtRoot() {
    if (this.workspaces.length === 1) this.startNewFolderInWorkspace(this.workspaces[0]);
  }

  startNewFileInWorkspace(ws: RootEntry) {
    ws.expanded = true;
    ws.pendingNew = { type: 'file', name: '' };
    setTimeout(() => {
      const inputs = this.hostRef.nativeElement.querySelectorAll('.root-new-item-input');
      // Focus the input that belongs to this workspace (last rendered if multiple)
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
  }

  startNewFolderInWorkspace(ws: RootEntry) {
    ws.expanded = true;
    ws.pendingNew = { type: 'folder', name: '' };
    setTimeout(() => {
      const inputs = this.hostRef.nativeElement.querySelectorAll('.root-new-item-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
  }

  async confirmRootNewItem(ws: RootEntry) {
    if (!ws.pendingNew) return;
    const rawName = ws.pendingNew.name.trim();
    if (!rawName) { ws.pendingNew = null; return; }

    const sep = ws.path.includes('\\') ? '\\' : '/';
    const newPath = ws.path + sep + rawName;

    if (ws.pendingNew.type === 'file') {
      const defaultContent = rawName.endsWith('.md') ? '# ' + rawName.replace(/\.md$/, '') + '\n\n' : '';
      const result = await this.electronService.createFileAtPath(newPath, defaultContent);
      if (result.success) {
        await this.loadWorkspace(ws);
        this.selectedPath = newPath;
        this.fileOpened.emit(newPath);
      }
    } else {
      const result = await this.electronService.createFolderAtPath(newPath);
      if (result.success) await this.loadWorkspace(ws);
    }
    ws.pendingNew = null;
  }

  cancelRootNewItem(ws: RootEntry) {
    ws.pendingNew = null;
  }

  onRootNewItemKeyDown(event: KeyboardEvent, ws: RootEntry) {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); this.confirmRootNewItem(ws); }
    if (event.key === 'Escape') { this.cancelRootNewItem(ws); }
  }

  // ── Delete ───────────────────────────────────────────────────

  async deleteItem(node: FileTreeNode) {
    this.closeContextMenu();
    const result = await this.electronService.deletePath(node.path);
    if (result.success) {
      if (this.selectedPath === node.path) {
        this.selectedPath = null;
        this.fileOpened.emit('');
      }
      const ws = this.findWorkspaceForNode(node.path);
      if (ws) await this.loadWorkspace(ws);
    }
  }

  private findWorkspaceForNode(nodePath: string): RootEntry | null {
    return this.workspaces.find(ws =>
      nodePath.startsWith(ws.path + '\\') || nodePath.startsWith(ws.path + '/')
    ) ?? null;
  }

  // ── Context Menu ─────────────────────────────────────────────

  showContextMenu(event: MouseEvent, node: FileTreeNode) {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu = { visible: true, x: event.clientX, y: event.clientY, node };
    document.addEventListener('click', this.closeContextMenuBound);
  }

  private closeContextMenuBound = () => this.closeContextMenu();

  closeContextMenu() {
    this.contextMenu.visible = false;
    document.removeEventListener('click', this.closeContextMenuBound);
  }

  contextNewFile() {
    if (this.contextMenu.node?.isDirectory) this.startNewFile(this.contextMenu.node);
  }

  contextNewFolder() {
    if (this.contextMenu.node?.isDirectory) this.startNewFolder(this.contextMenu.node);
  }

  contextRename() {
    if (this.contextMenu.node) this.startRename(this.contextMenu.node);
  }

  contextDelete() {
    if (this.contextMenu.node) this.deleteItem(this.contextMenu.node);
  }

  // ── Keyboard in tree ─────────────────────────────────────────

  @HostListener('keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    const allNodes = this.workspaces.flatMap(ws => ws.nodes);
    if (event.key === 'F2' && this.selectedPath) {
      const node = this.findNodeByPath(allNodes, this.selectedPath);
      if (node) this.startRename(node);
    }
    if (event.key === 'Delete' && this.selectedPath) {
      const node = this.findNodeByPath(allNodes, this.selectedPath);
      if (node) this.deleteItem(node);
    }
  }

  private findNodeByPath(nodes: FileTreeNode[], targetPath: string): FileTreeNode | null {
    for (const node of nodes) {
      if (node.path === targetPath) return node;
      if (node.isDirectory && node.children) {
        const found = this.findNodeByPath(node.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  }

  // ── Reveal in Tree ──────────────────────────────────────────

  /** Expand all parent directories so the given file path is visible in the tree. */
  private async revealPath(filePath: string) {
    const ws = this.findWorkspaceForNode(filePath);
    if (!ws) return;

    ws.expanded = true;

    // Build the list of path segments between the workspace root and the file
    const sep = ws.path.includes('\\') ? '\\' : '/';
    const relative = filePath.startsWith(ws.path + sep)
      ? filePath.substring(ws.path.length + 1)
      : null;
    if (!relative) return;

    const segments = relative.split(/[/\\]/);
    segments.pop(); // remove the filename — we only need to expand directories

    let currentNodes = ws.nodes;
    let currentPath = ws.path;

    for (const segment of segments) {
      currentPath += sep + segment;
      const dirNode = currentNodes.find(n => n.isDirectory && n.path === currentPath);
      if (!dirNode) break;

      // Load children if not yet loaded
      if (dirNode.children === null) {
        dirNode.loading = true;
        try {
          const contents = await this.electronService.getDirectoryContents(dirNode.path);
          dirNode.children = this.buildNodes(contents);
        } catch (_) {
          dirNode.children = [];
        }
        dirNode.loading = false;
      }
      dirNode.expanded = true;
      currentNodes = dirNode.children;
    }
  }

  // ── Display Helpers ──────────────────────────────────────────

  getFileName(filePath: string): string {
    return filePath.split(/[/\\]/).pop() || filePath;
  }

  getFileDir(filePath: string): string {
    const parts = filePath.split(/[/\\]/);
    parts.pop();
    return parts.join('/') || '/';
  }

  getWorkspaceName(wsPath: string): string {
    return wsPath.split(/[/\\]/).pop()?.toUpperCase() || 'WORKSPACE';
  }

  isMarkdown(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.md') || lower.endsWith('.markdown');
  }

  trackByPath(_: number, node: FileTreeNode): string {
    return node.path;
  }

  trackByFilePath(_: number, filePath: string): string {
    return filePath;
  }

  trackByWorkspacePath(_: number, ws: RootEntry): string {
    return ws.path;
  }

  collapseAll() {
    for (const ws of this.workspaces) {
      this.collapseNodes(ws.nodes);
    }
  }

  private collapseNodes(nodes: FileTreeNode[]) {
    for (const node of nodes) {
      node.expanded = false;
      if (node.children) this.collapseNodes(node.children);
    }
  }

  // ── File Search ──────────────────────────────────────────────

  toggleSearch() {
    this.searchActive = !this.searchActive;
    if (this.searchActive) {
      setTimeout(() => {
        const input = this.hostRef.nativeElement.querySelector('.search-input');
        if (input) input.focus();
      }, 50);
    } else {
      this.searchQuery = '';
      this.searchResults = [];
      if (this.searchDebounce) clearTimeout(this.searchDebounce);
      this.searchLoading = false;
    }
  }

  onSearchInput() {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    const q = this.searchQuery.trim();
    if (!q) {
      this.searchResults = [];
      this.searchLoading = false;
      return;
    }
    this.searchLoading = true;
    this.searchDebounce = setTimeout(() => this.performSearch(), 250);
  }

  private async performSearch() {
    const query = this.searchQuery.trim().toLowerCase();
    if (!query || !this.workspaces.length) {
      this.searchResults = [];
      this.searchLoading = false;
      return;
    }
    const results: Array<{ name: string; path: string }> = [];
    for (const ws of this.workspaces) {
      await this.collectMatches(ws.path, query, results);
    }
    this.searchResults = results;
    this.searchLoading = false;
    this.cdr.markForCheck();
  }

  private async collectMatches(dirPath: string, query: string, out: Array<{ name: string; path: string }>) {
    let items: any[];
    try {
      items = await this.electronService.getDirectoryContents(dirPath);
    } catch {
      return;
    }
    for (const item of items) {
      if (item.isDirectory) {
        await this.collectMatches(item.path, query, out);
      } else if (this.isMarkdown(item.name) && item.name.toLowerCase().includes(query)) {
        out.push({ name: item.name, path: item.path });
      }
    }
  }

  openSearchResult(path: string) {
    this.selectedPath = path;
    this.fileOpened.emit(path);
  }

  clearSearch() {
    this.searchQuery = '';
    this.searchResults = [];
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchLoading = false;
    setTimeout(() => {
      const input = this.hostRef.nativeElement.querySelector('.search-input');
      if (input) input.focus();
    }, 0);
  }

  onSearchKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      if (this.searchQuery) {
        this.clearSearch();
      } else {
        this.toggleSearch();
      }
    }
  }

  trackBySearchPath(_: number, r: { name: string; path: string }): string {
    return r.path;
  }
}
