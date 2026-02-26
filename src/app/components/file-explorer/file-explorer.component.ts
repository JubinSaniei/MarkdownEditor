import {
  Component, Input, Output, EventEmitter, OnInit, OnChanges, SimpleChanges,
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

interface SubRootEntry {
  path: string;
  nodes: FileTreeNode[];
  expanded: boolean;
  loading: boolean;
  pendingNew: { type: 'file' | 'folder'; name: string } | null;
}

interface VirtualWorkspaceState {
  id: string;
  name: string;
  isRenaming: boolean;
  renameValue: string;
  expanded: boolean;
  subRoots: SubRootEntry[];
  files: string[]; // individual files added directly
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
export class FileExplorerComponent implements OnInit, OnChanges, OnDestroy {
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
  virtualWorkspaces: VirtualWorkspaceState[] = [];
  isCreatingVirtualWs = false;
  pendingVirtualWsName = '';

  private clickTimer: any = null;
  recentExpanded: boolean = true;
  private watchedRoots = new Set<string>();
  private savedExplorerState: any = null;

  private readonly EXPLORER_STATE_KEY = 'explorerState';

  searchActive = false;
  searchQuery = '';
  searchResults: Array<{ name: string; path: string }> = [];
  searchLoading = false;
  private searchDebounce: any = null;
  private searchToken = 0;
  private saveStateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly MAX_SEARCH_RESULTS = 200;

  contextMenu: ContextMenu = { visible: false, x: 0, y: 0, node: null };

  constructor(
    private electronService: ElectronService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
    private hostRef: ElementRef
  ) {}

  ngOnInit() {
    this.loadExplorerState();
    this.initVirtualWorkspaces();
    this.electronService.onDirectoryChanged((changedPath: string) => {
      this.zone.run(() => {
        const ws = this.workspaces.find(w => w.path === changedPath);
        if (ws) { this.smartRefreshWorkspace(ws); return; }
        for (const vws of this.virtualWorkspaces) {
          const subRoot = vws.subRoots.find(sr => sr.path === changedPath);
          if (subRoot) { this.smartRefreshSubRoot(subRoot); return; }
        }
      });
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['workspaceRoots']) {
      const newRoots: string[] = this.workspaceRoots || [];
      // Unwatch roots that were removed
      for (const watched of this.watchedRoots) {
        const inReal = newRoots.includes(watched);
        const inVirtual = this.virtualWorkspaces.some(vws => vws.subRoots.some(sr => sr.path === watched));
        if (!inReal && !inVirtual) {
          this.electronService.unwatchDirectory(watched);
          this.watchedRoots.delete(watched);
        }
      }
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
    if (this.saveStateTimer) { clearTimeout(this.saveStateTimer); this.saveStateTimer = null; this.flushExplorerState(); }
    this.electronService.removeDirectoryChangedListener();
    for (const dirPath of this.watchedRoots) {
      this.electronService.unwatchDirectory(dirPath);
    }
    this.watchedRoots.clear();
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
    if (!this.watchedRoots.has(ws.path)) {
      this.electronService.watchDirectory(ws.path);
      this.watchedRoots.add(ws.path);
    }
    await this.applyWorkspaceSavedState(ws);
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
    this.saveExplorerState();
  }

  async refreshNode(node: FileTreeNode) {
    if (!node.isDirectory) return;
    try {
      const contents = await this.electronService.getDirectoryContents(node.path);
      node.children = this.buildNodes(contents);
    } catch (_) {}
  }

  private async smartRefreshWorkspace(ws: RootEntry) {
    try {
      const contents = await this.electronService.getDirectoryContents(ws.path);
      ws.nodes = this.mergeNodeLists(ws.nodes, this.buildNodes(contents));
    } catch (_) { return; }
    await this.refreshExpandedNodes(ws.nodes);
    this.cdr.detectChanges();
  }

  private async refreshExpandedNodes(nodes: FileTreeNode[]) {
    for (const node of nodes) {
      if (node.isDirectory && node.expanded && node.children !== null) {
        try {
          const contents = await this.electronService.getDirectoryContents(node.path);
          node.children = this.mergeNodeLists(node.children, this.buildNodes(contents));
          await this.refreshExpandedNodes(node.children);
        } catch (_) {}
      }
    }
  }

  private mergeNodeLists(existing: FileTreeNode[], fresh: FileTreeNode[]): FileTreeNode[] {
    return fresh.map(freshNode => {
      const match = existing.find(n => n.path === freshNode.path);
      if (match && freshNode.isDirectory) {
        return { ...freshNode, expanded: match.expanded, children: match.children, loading: match.loading, isRenaming: match.isRenaming, renameValue: match.renameValue, pendingNew: match.pendingNew };
      }
      return freshNode;
    });
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

  // ── Virtual Workspace Management ─────────────────────────────

  startCreateVirtualWorkspace() {
    this.isCreatingVirtualWs = true;
    this.pendingVirtualWsName = '';
    setTimeout(() => {
      const input = this.hostRef.nativeElement.querySelector('.new-vws-input');
      if (input) { input.focus(); }
    }, 50);
  }

  confirmCreateVirtualWorkspace() {
    const name = this.pendingVirtualWsName.trim();
    if (!name) { this.cancelCreateVirtualWorkspace(); return; }
    const id = 'vws_' + Date.now();
    const vws: VirtualWorkspaceState = {
      id,
      name,
      isRenaming: false,
      renameValue: '',
      expanded: true,
      subRoots: [],
      files: []
    };
    this.virtualWorkspaces.push(vws);
    this.isCreatingVirtualWs = false;
    this.pendingVirtualWsName = '';
    this.saveExplorerState();
  }

  cancelCreateVirtualWorkspace() {
    this.isCreatingVirtualWs = false;
    this.pendingVirtualWsName = '';
  }

  onVirtualWsCreateKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); this.confirmCreateVirtualWorkspace(); }
    if (event.key === 'Escape') { this.cancelCreateVirtualWorkspace(); }
  }

  async addFolderToVirtualWorkspace(vws: VirtualWorkspaceState) {
    const folderPath = await this.electronService.selectFolder();
    if (!folderPath) return;
    if (vws.subRoots.some(sr => sr.path === folderPath)) return;
    const subRoot: SubRootEntry = {
      path: folderPath,
      nodes: [],
      expanded: true,
      loading: false,
      pendingNew: null
    };
    vws.subRoots.push(subRoot);
    await this.loadSubRoot(subRoot);
    this.saveExplorerState();
    this.cdr.detectChanges();
  }

  removeFolderFromVirtualWorkspace(vws: VirtualWorkspaceState, subRoot: SubRootEntry) {
    if (this.watchedRoots.has(subRoot.path)) {
      this.electronService.unwatchDirectory(subRoot.path);
      this.watchedRoots.delete(subRoot.path);
    }
    vws.subRoots = vws.subRoots.filter(sr => sr !== subRoot);
    this.saveExplorerState();
  }

  async addFileToVirtualWorkspace(vws: VirtualWorkspaceState) {
    const filePath = await this.electronService.selectFile();
    if (!filePath) return;
    if (vws.files.includes(filePath)) return;
    vws.files.push(filePath);
    this.saveExplorerState();
  }

  removeFileFromVirtualWorkspace(vws: VirtualWorkspaceState, filePath: string) {
    vws.files = vws.files.filter(f => f !== filePath);
    this.saveExplorerState();
  }

  removeVirtualWorkspace(vws: VirtualWorkspaceState) {
    for (const subRoot of vws.subRoots) {
      if (this.watchedRoots.has(subRoot.path)) {
        this.electronService.unwatchDirectory(subRoot.path);
        this.watchedRoots.delete(subRoot.path);
      }
    }
    this.virtualWorkspaces = this.virtualWorkspaces.filter(v => v !== vws);
    this.saveExplorerState();
  }

  startRenameVirtualWorkspace(vws: VirtualWorkspaceState) {
    vws.isRenaming = true;
    vws.renameValue = vws.name;
    setTimeout(() => {
      const input = this.hostRef.nativeElement.querySelector('.vws-rename-input');
      if (input) { input.focus(); input.select(); }
    }, 50);
  }

  applyRenameVirtualWorkspace(vws: VirtualWorkspaceState) {
    const newName = vws.renameValue.trim();
    if (newName) vws.name = newName;
    vws.isRenaming = false;
    this.saveExplorerState();
  }

  cancelRenameVirtualWorkspace(vws: VirtualWorkspaceState) {
    vws.isRenaming = false;
  }

  onVirtualWsRenameKeyDown(event: KeyboardEvent, vws: VirtualWorkspaceState) {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); this.applyRenameVirtualWorkspace(vws); }
    if (event.key === 'Escape') { this.cancelRenameVirtualWorkspace(vws); }
  }

  toggleVirtualWorkspaceExpanded(vws: VirtualWorkspaceState) {
    vws.expanded = !vws.expanded;
    this.saveExplorerState();
  }

  // ── Sub-root Loading ─────────────────────────────────────────

  async loadSubRoot(subRoot: SubRootEntry) {
    subRoot.loading = true;
    try {
      const contents = await this.electronService.getDirectoryContents(subRoot.path);
      subRoot.nodes = this.buildNodes(contents);
    } catch (_) {
      subRoot.nodes = [];
    }
    subRoot.loading = false;
    if (!this.watchedRoots.has(subRoot.path)) {
      this.electronService.watchDirectory(subRoot.path);
      this.watchedRoots.add(subRoot.path);
    }
  }

  private async smartRefreshSubRoot(subRoot: SubRootEntry) {
    try {
      const contents = await this.electronService.getDirectoryContents(subRoot.path);
      subRoot.nodes = this.mergeNodeLists(subRoot.nodes, this.buildNodes(contents));
    } catch (_) { return; }
    await this.refreshExpandedNodes(subRoot.nodes);
    this.cdr.detectChanges();
  }

  async toggleSubRoot(subRoot: SubRootEntry) {
    subRoot.expanded = !subRoot.expanded;
    if (subRoot.expanded && subRoot.nodes.length === 0) {
      await this.loadSubRoot(subRoot);
    }
    this.saveExplorerState();
  }

  startNewFileInSubRoot(subRoot: SubRootEntry) {
    subRoot.expanded = true;
    subRoot.pendingNew = { type: 'file', name: '' };
    setTimeout(() => {
      const inputs = this.hostRef.nativeElement.querySelectorAll('.root-new-item-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
  }

  startNewFolderInSubRoot(subRoot: SubRootEntry) {
    subRoot.expanded = true;
    subRoot.pendingNew = { type: 'folder', name: '' };
    setTimeout(() => {
      const inputs = this.hostRef.nativeElement.querySelectorAll('.root-new-item-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
  }

  async confirmSubRootNewItem(subRoot: SubRootEntry) {
    if (!subRoot.pendingNew) return;
    const rawName = subRoot.pendingNew.name.trim();
    if (!rawName) { subRoot.pendingNew = null; return; }

    const sep = subRoot.path.includes('\\') ? '\\' : '/';
    const newPath = subRoot.path + sep + rawName;

    if (subRoot.pendingNew.type === 'file') {
      const defaultContent = rawName.endsWith('.md') ? '# ' + rawName.replace(/\.md$/, '') + '\n\n' : '';
      const result = await this.electronService.createFileAtPath(newPath, defaultContent);
      if (result.success) {
        await this.loadSubRoot(subRoot);
        this.selectedPath = newPath;
        this.fileOpened.emit(newPath);
      }
    } else {
      const result = await this.electronService.createFolderAtPath(newPath);
      if (result.success) await this.loadSubRoot(subRoot);
    }
    subRoot.pendingNew = null;
  }

  cancelSubRootNewItem(subRoot: SubRootEntry) {
    subRoot.pendingNew = null;
  }

  onSubRootNewItemKeyDown(event: KeyboardEvent, subRoot: SubRootEntry) {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); this.confirmSubRootNewItem(subRoot); }
    if (event.key === 'Escape') { this.cancelSubRootNewItem(subRoot); }
  }

  // ── Virtual Workspace Init ────────────────────────────────────

  private async initVirtualWorkspaces() {
    const savedVwsList = this.savedExplorerState?.virtualWorkspaces;
    if (!savedVwsList || !Array.isArray(savedVwsList)) return;

    for (const saved of savedVwsList) {
      if (!saved.id || !saved.name) continue;
      const vws: VirtualWorkspaceState = {
        id: saved.id,
        name: saved.name,
        isRenaming: false,
        renameValue: '',
        expanded: saved.expanded ?? true,
        subRoots: [],
        files: Array.isArray(saved.files) ? saved.files : []
      };
      for (const savedSr of (saved.subRoots || [])) {
        if (!savedSr.path) continue;
        const subRoot: SubRootEntry = {
          path: savedSr.path,
          nodes: [],
          expanded: savedSr.expanded ?? true,
          loading: false,
          pendingNew: null
        };
        vws.subRoots.push(subRoot);
        await this.loadSubRoot(subRoot);
        if (subRoot.expanded && savedSr.expandedPaths?.length > 0) {
          const expandedSet = new Set<string>(savedSr.expandedPaths as string[]);
          await this.restoreNodeExpansion(subRoot.nodes, expandedSet);
        }
      }
      this.virtualWorkspaces.push(vws);
    }
    this.cdr.detectChanges();
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

  openVwsFile(filePath: string) {
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
      return;
    }
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.selectedPath = filePath;
      this.fileOpened.emit(filePath);
    }, 350);
  }

  openVwsFileNewTab(filePath: string) {
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.selectedPath = filePath;
    this.fileDoubleClicked.emit(filePath);
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
      if (ws) { await this.loadWorkspace(ws); return; }
      const subRoot = this.findSubRootForNode(node.path);
      if (subRoot) await this.loadSubRoot(subRoot);
    }
  }

  private findWorkspaceForNode(nodePath: string): RootEntry | null {
    return this.workspaces.find(ws =>
      nodePath.startsWith(ws.path + '\\') || nodePath.startsWith(ws.path + '/')
    ) ?? null;
  }

  private findSubRootForNode(nodePath: string): SubRootEntry | null {
    for (const vws of this.virtualWorkspaces) {
      const subRoot = vws.subRoots.find(sr =>
        nodePath.startsWith(sr.path + '\\') || nodePath.startsWith(sr.path + '/')
      );
      if (subRoot) return subRoot;
    }
    return null;
  }

  // ── Context Menu ─────────────────────────────────────────────

  showContextMenu(event: MouseEvent, node: FileTreeNode) {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu = { visible: true, x: event.clientX, y: event.clientY, node };
    document.removeEventListener('click', this.closeContextMenuBound);
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
    // Try real workspaces first
    const ws = this.findWorkspaceForNode(filePath);
    if (ws) {
      ws.expanded = true;
      const sep = ws.path.includes('\\') ? '\\' : '/';
      const relative = filePath.startsWith(ws.path + sep)
        ? filePath.substring(ws.path.length + 1)
        : null;
      if (!relative) return;

      const segments = relative.split(/[/\\]/);
      segments.pop();

      let currentNodes = ws.nodes;
      let currentPath = ws.path;

      for (const segment of segments) {
        currentPath += sep + segment;
        const dirNode = currentNodes.find(n => n.isDirectory && n.path === currentPath);
        if (!dirNode) break;
        if (dirNode.children === null) {
          dirNode.loading = true;
          try {
            const contents = await this.electronService.getDirectoryContents(dirNode.path);
            dirNode.children = this.buildNodes(contents);
          } catch (_) { dirNode.children = []; }
          dirNode.loading = false;
        }
        dirNode.expanded = true;
        currentNodes = dirNode.children;
      }
      return;
    }

    // Try virtual workspace sub-roots
    const subRoot = this.findSubRootForNode(filePath);
    if (!subRoot) return;

    const vws = this.virtualWorkspaces.find(v => v.subRoots.includes(subRoot));
    if (vws) vws.expanded = true;
    subRoot.expanded = true;

    const sep = subRoot.path.includes('\\') ? '\\' : '/';
    const relative = filePath.startsWith(subRoot.path + sep)
      ? filePath.substring(subRoot.path.length + 1)
      : null;
    if (!relative) return;

    const segments = relative.split(/[/\\]/);
    segments.pop();

    let currentNodes = subRoot.nodes;
    let currentPath = subRoot.path;

    for (const segment of segments) {
      currentPath += sep + segment;
      const dirNode = currentNodes.find(n => n.isDirectory && n.path === currentPath);
      if (!dirNode) break;
      if (dirNode.children === null) {
        dirNode.loading = true;
        try {
          const contents = await this.electronService.getDirectoryContents(dirNode.path);
          dirNode.children = this.buildNodes(contents);
        } catch (_) { dirNode.children = []; }
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

  trackByVirtualWsId(_: number, vws: VirtualWorkspaceState): string {
    return vws.id;
  }

  collapseAll() {
    const anyFolderExpanded = this.workspaces.some(
      ws => ws.expanded && this.hasExpandedNode(ws.nodes)
    ) || this.virtualWorkspaces.some(
      vws => vws.expanded && vws.subRoots.some(sr => sr.expanded && this.hasExpandedNode(sr.nodes))
    );

    if (anyFolderExpanded) {
      // Stage 1: collapse all folder nodes, keep workspace headers open
      for (const ws of this.workspaces) {
        this.collapseNodes(ws.nodes);
      }
      for (const vws of this.virtualWorkspaces) {
        for (const subRoot of vws.subRoots) {
          this.collapseNodes(subRoot.nodes);
        }
      }
    } else {
      // Stage 2: collapse workspace headers and recent section
      for (const ws of this.workspaces) {
        ws.expanded = false;
      }
      for (const vws of this.virtualWorkspaces) {
        vws.expanded = false;
      }
      this.recentExpanded = false;
    }
    this.saveExplorerState();
  }

  private hasExpandedNode(nodes: FileTreeNode[]): boolean {
    for (const node of nodes) {
      if (node.isDirectory && node.expanded) return true;
      if (node.children && this.hasExpandedNode(node.children)) return true;
    }
    return false;
  }

  private collapseNodes(nodes: FileTreeNode[]) {
    for (const node of nodes) {
      node.expanded = false;
      if (node.children) this.collapseNodes(node.children);
    }
  }

  toggleRecentExpanded() {
    this.recentExpanded = !this.recentExpanded;
    this.saveExplorerState();
  }

  toggleWorkspaceExpanded(ws: RootEntry) {
    ws.expanded = !ws.expanded;
    this.saveExplorerState();
  }

  // ── Explorer State Persistence ───────────────────────────────

  private loadExplorerState() {
    try {
      const raw = localStorage.getItem(this.EXPLORER_STATE_KEY);
      this.savedExplorerState = raw ? JSON.parse(raw) : null;
    } catch (_) {
      this.savedExplorerState = null;
    }
    if (this.savedExplorerState?.recentExpanded !== undefined) {
      this.recentExpanded = this.savedExplorerState.recentExpanded;
    }
  }

  private saveExplorerState() {
    if (this.saveStateTimer) clearTimeout(this.saveStateTimer);
    this.saveStateTimer = setTimeout(() => {
      this.saveStateTimer = null;
      this.flushExplorerState();
    }, 300);
  }

  private flushExplorerState() {
    const state: any = {
      recentExpanded: this.recentExpanded,
      workspaces: {} as Record<string, { expanded: boolean; expandedPaths: string[] }>,
      virtualWorkspaces: [] as any[]
    };
    for (const ws of this.workspaces) {
      const expandedPaths: string[] = [];
      this.collectExpandedPaths(ws.nodes, expandedPaths);
      state.workspaces[ws.path] = { expanded: ws.expanded, expandedPaths };
    }
    for (const vws of this.virtualWorkspaces) {
      state.virtualWorkspaces.push({
        id: vws.id,
        name: vws.name,
        expanded: vws.expanded,
        files: vws.files,
        subRoots: vws.subRoots.map(sr => {
          const expandedPaths: string[] = [];
          this.collectExpandedPaths(sr.nodes, expandedPaths);
          return { path: sr.path, expanded: sr.expanded, expandedPaths };
        })
      });
    }
    try {
      localStorage.setItem(this.EXPLORER_STATE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  private collectExpandedPaths(nodes: FileTreeNode[], out: string[]) {
    for (const node of nodes) {
      if (node.isDirectory && node.expanded) {
        out.push(node.path);
        if (node.children) this.collectExpandedPaths(node.children, out);
      }
    }
  }

  private async applyWorkspaceSavedState(ws: RootEntry) {
    const wsState = this.savedExplorerState?.workspaces?.[ws.path];
    if (!wsState) return;

    ws.expanded = wsState.expanded ?? true;

    if (ws.expanded && wsState.expandedPaths?.length > 0) {
      const expandedSet = new Set<string>(wsState.expandedPaths as string[]);
      await this.restoreNodeExpansion(ws.nodes, expandedSet);
    }
  }

  private async restoreNodeExpansion(nodes: FileTreeNode[], expandedPaths: Set<string>) {
    for (const node of nodes) {
      if (!node.isDirectory || !expandedPaths.has(node.path)) continue;
      if (node.children === null) {
        node.loading = true;
        try {
          const contents = await this.electronService.getDirectoryContents(node.path);
          node.children = this.buildNodes(contents);
        } catch (_) {
          node.children = [];
        }
        node.loading = false;
      }
      node.expanded = true;
      if (node.children) {
        await this.restoreNodeExpansion(node.children, expandedPaths);
      }
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
    const hasRoots = this.workspaces.length > 0 || this.virtualWorkspaces.some(v => v.subRoots.length > 0);
    if (!query || !hasRoots) {
      this.searchResults = [];
      this.searchLoading = false;
      return;
    }
    const token = ++this.searchToken;
    const results: Array<{ name: string; path: string }> = [];
    for (const ws of this.workspaces) {
      await this.collectMatches(ws.path, query, results, token, 0);
      if (this.searchToken !== token) return;
    }
    for (const vws of this.virtualWorkspaces) {
      for (const subRoot of vws.subRoots) {
        await this.collectMatches(subRoot.path, query, results, token, 0);
        if (this.searchToken !== token) return;
      }
    }
    this.searchResults = results;
    if (results.length >= this.MAX_SEARCH_RESULTS) {
      this.searchResults = results.slice(0, this.MAX_SEARCH_RESULTS);
    }
    this.searchLoading = false;
    this.cdr.markForCheck();
  }

  private async collectMatches(
    dirPath: string,
    query: string,
    out: Array<{ name: string; path: string }>,
    token: number,
    depth: number
  ) {
    if (depth > 8 || out.length >= this.MAX_SEARCH_RESULTS || this.searchToken !== token) return;
    let items: any[];
    try {
      items = await this.electronService.getDirectoryContents(dirPath);
    } catch {
      return;
    }
    for (const item of items) {
      if (this.searchToken !== token || out.length >= this.MAX_SEARCH_RESULTS) return;
      if (item.isDirectory) {
        await this.collectMatches(item.path, query, out, token, depth + 1);
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
