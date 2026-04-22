import {
  Component, Input, Output, EventEmitter, OnDestroy,
  ViewChild, ElementRef, AfterViewChecked
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import { AiService } from '../../services/ai.service';
import { AiSettingsService } from '../../services/ai-settings.service';
import { ElectronService } from '../../services/electron.service';
import { AiProvider, AiChatMessage } from '../../interfaces/ai-settings.interface';

function escapeHtmlForPanel(text: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

const panelMarked = new Marked({ gfm: true, breaks: true });
panelMarked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : '';
      const escapedLang = escapeHtmlForPanel(language || 'text');
      try {
        const highlighted = language
          ? hljs.highlight(text, { language }).value
          : hljs.highlightAuto(text).value;
        return `<pre class="hljs"><code class="language-${escapedLang}">${highlighted}</code></pre>`;
      } catch (_) {
        return `<pre class="hljs"><code>${escapeHtmlForPanel(text)}</code></pre>`;
      }
    }
  }
});

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface WorkspaceFile {
  name: string;
  path: string;
  relativePath: string;
  content?: string;
}

interface ContextFolder {
  path: string;
  name: string;
}

const STOP_WORDS = new Set([
  'a','an','the','i','me','my','we','our','you','your','he','she','it','its',
  'they','them','their','in','on','at','to','for','of','from','by','with',
  'about','into','through','between','and','or','but','nor','so','yet',
  'is','are','was','were','be','been','being','has','have','had','do','does','did',
  'will','would','shall','should','can','could','may','might','must',
  'how','what','where','when','why','which','who','whom',
  'this','that','these','those','not','no','if','then','than','as',
  'all','each','every','some','any','just','also','very','too',
]);

@Component({
  selector: 'app-ai-panel',
  templateUrl: './ai-panel.component.html',
  styleUrls: ['./ai-panel.component.scss'],
  standalone: false
})
export class AiPanelComponent implements OnDestroy, AfterViewChecked {
  @Input() currentContent: string = '';
  @Input() currentFilePath: string | null = null;
  @Input() workspaceRoots: string[] = [];
  @Output() insertText = new EventEmitter<string>();
  @Output() openSettings = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  @ViewChild('messagesContainer') messagesContainerRef?: ElementRef<HTMLElement>;
  @ViewChild('promptInput') promptInputRef?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('fileSearchInput') fileSearchInputRef?: ElementRef<HTMLInputElement>;

  messages: ChatMessage[] = [];
  promptText: string = '';
  isStreaming: boolean = false;
  streamingText: string = '';
  includeFileContent: boolean = false;
  error: string = '';

  // File picker
  showFilePicker: boolean = false;
  fileSearch: string = '';
  workspaceFiles: WorkspaceFile[] = [];
  contextFiles: WorkspaceFile[] = [];
  isLoadingFiles: boolean = false;

  // Folder context
  contextFolders: ContextFolder[] = [];
  isSearchingFolders: boolean = false;

  // Folder picker
  showFolderPicker: boolean = false;
  folderSearch: string = '';
  workspaceFolders: ContextFolder[] = [];
  isLoadingFolders: boolean = false;

  // Folder drop from explorer
  isDraggingFolder: boolean = false;
  private folderDragCounter: number = 0;
  private readonly FOLDER_DRAG_TYPE = 'application/x-md-editor-folder';

  @ViewChild('folderSearchInput') folderSearchInputRef?: ElementRef<HTMLInputElement>;

  private streamSub?: Subscription;
  private shouldScrollToBottom = false;
  // True when the user has manually scrolled up during streaming.
  // Auto-scroll is suspended until they return within SCROLL_RESUME_THRESHOLD
  // of the bottom, or they send a new message.
  private userScrolledUp = false;
  private static readonly SCROLL_RESUME_THRESHOLD = 60; // px from bottom
  private scrollListener: (() => void) | null = null;

  constructor(
    private aiService: AiService,
    private aiSettingsService: AiSettingsService,
    private electronService: ElectronService,
    private sanitizer: DomSanitizer
  ) {}

  renderMarkdown(content: string): SafeHtml {
    const html = panelMarked.parse(content) as string;
    const clean = DOMPurify.sanitize(html);
    return this.sanitizer.bypassSecurityTrustHtml(clean);
  }

  renderStreamingMarkdown(content: string): SafeHtml {
    if (!content) return this.sanitizer.bypassSecurityTrustHtml('<span class="aip-cursor"></span>');
    const html = panelMarked.parse(content) as string;
    const clean = DOMPurify.sanitize(html);
    // Insert blinking cursor before the last closing block tag
    const cursor = '<span class="aip-cursor"></span>';
    const patched = clean.replace(/<\/(p|li|h[1-6]|pre|blockquote|td|code)>(?![\s\S]*<\/(p|li|h[1-6]|pre|blockquote|td|code)>)/, cursor + '</$1>');
    return this.sanitizer.bypassSecurityTrustHtml(patched === clean ? clean + cursor : patched);
  }

  get activeProvider(): AiProvider {
    return this.aiSettingsService.snapshot.activeProvider;
  }

  get providerLabel(): string {
    const labels: Record<AiProvider, string> = {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      bedrock: 'Bedrock',
    };
    return labels[this.activeProvider];
  }

  get currentFileName(): string {
    if (!this.currentFilePath) return 'Untitled';
    return this.currentFilePath.split(/[/\\]/).pop() || 'Untitled';
  }

  get lastAssistantMessage(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') return this.messages[i].content;
    }
    return null;
  }

  get filteredFiles(): WorkspaceFile[] {
    const q = this.fileSearch.toLowerCase();
    const attached = new Set(this.contextFiles.map(f => f.path));
    return this.workspaceFiles.filter(f =>
      !attached.has(f.path) &&
      (!q || f.relativePath.toLowerCase().includes(q))
    );
  }

  get filteredFolders(): ContextFolder[] {
    const q = this.folderSearch.toLowerCase();
    const attached = new Set(this.contextFolders.map(f => f.path));
    return this.workspaceFolders.filter(f =>
      !attached.has(f.path) &&
      (!q || f.name.toLowerCase().includes(q))
    );
  }

  ngAfterViewChecked(): void {
    // Attach scroll listener the first time the container is available.
    const el = this.messagesContainerRef?.nativeElement;
    if (el && !this.scrollListener) {
      this.scrollListener = () => {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        this.userScrolledUp = distanceFromBottom > AiPanelComponent.SCROLL_RESUME_THRESHOLD;
      };
      el.addEventListener('scroll', this.scrollListener, { passive: true });
    }

    if (this.shouldScrollToBottom) {
      this.shouldScrollToBottom = false;
      if (!this.userScrolledUp) {
        this.scrollToBottom();
      }
    }
  }

  ngOnDestroy(): void {
    this.streamSub?.unsubscribe();
    const el = this.messagesContainerRef?.nativeElement;
    if (el && this.scrollListener) {
      el.removeEventListener('scroll', this.scrollListener);
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  // ── Folder Drop from Explorer ───────────────────────────────

  onFolderDragEnter(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(this.FOLDER_DRAG_TYPE)) return;
    event.preventDefault();
    this.folderDragCounter++;
    this.isDraggingFolder = true;
  }

  onFolderDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(this.FOLDER_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  onFolderDragLeave(event: DragEvent): void {
    this.folderDragCounter--;
    if (this.folderDragCounter <= 0) {
      this.folderDragCounter = 0;
      this.isDraggingFolder = false;
    }
  }

  onFolderDrop(event: DragEvent): void {
    event.preventDefault();
    this.folderDragCounter = 0;
    this.isDraggingFolder = false;
    const raw = event.dataTransfer?.getData(this.FOLDER_DRAG_TYPE);
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as { path: string; name: string };
      if (data.path && !this.contextFolders.find(f => f.path === data.path)) {
        this.contextFolders.push({ path: data.path, name: data.name || data.path.split(/[/\\]/).pop() || data.path });
      }
    } catch (_) {}
  }

  // ── File Picker ──────────────────────────────────────────────

  async openFilePicker(): Promise<void> {
    this.showFilePicker = true;
    this.fileSearch = '';
    if (this.workspaceFiles.length === 0) {
      await this.loadWorkspaceFiles();
    }
    setTimeout(() => this.fileSearchInputRef?.nativeElement.focus(), 0);
  }

  closeFilePicker(): void {
    this.showFilePicker = false;
    this.fileSearch = '';
  }

  async addContextFile(file: WorkspaceFile): Promise<void> {
    if (file.content === undefined) {
      file.content = await this.electronService.readFile(file.path);
    }
    this.contextFiles.push(file);
    this.closeFilePicker();
  }

  removeContextFile(path: string): void {
    this.contextFiles = this.contextFiles.filter(f => f.path !== path);
  }

  private async loadWorkspaceFiles(): Promise<void> {
    this.isLoadingFiles = true;
    this.workspaceFiles = [];

    // Real workspace roots
    for (const root of this.workspaceRoots) {
      await this.collectMdFiles(root, root, 0);
    }

    // Virtual workspace sub-roots + individual files (from localStorage)
    try {
      const raw = localStorage.getItem('explorerState');
      if (raw) {
        const state = JSON.parse(raw);
        if (Array.isArray(state.virtualWorkspaces)) {
          const existing = new Set(this.workspaceFiles.map(f => f.path));
          for (const vws of state.virtualWorkspaces) {
            const wsLabel = vws.name || 'Virtual';

            // Sub-root folders — recurse for .md files
            if (Array.isArray(vws.subRoots)) {
              for (const sr of vws.subRoots) {
                if (!sr.path) continue;
                await this.collectMdFiles(sr.path, sr.path, 0);
              }
            }

            // Individual files added directly to the virtual workspace
            if (Array.isArray(vws.files)) {
              for (const filePath of vws.files) {
                if (!filePath || existing.has(filePath)) continue;
                if (!/\.(md|markdown)$/i.test(filePath)) continue;
                const name = filePath.split(/[/\\]/).pop() || filePath;
                this.workspaceFiles.push({ name, path: filePath, relativePath: `${wsLabel}/${name}` });
                existing.add(filePath);
              }
            }
          }
        }
      }
    } catch (_) {}

    this.isLoadingFiles = false;
  }

  private async collectMdFiles(rootPath: string, dirPath: string, depth: number): Promise<void> {
    if (depth > 6) return;
    try {
      const items = await this.electronService.getDirectoryContents(dirPath);
      for (const item of items) {
        if (item.isDirectory) {
          await this.collectMdFiles(rootPath, item.path, depth + 1);
        } else if (/\.(md|markdown)$/i.test(item.name)) {
          const relativePath = item.path
            .replace(rootPath, '')
            .replace(/^[/\\]/, '')
            .replace(/\\/g, '/');
          this.workspaceFiles.push({ name: item.name, path: item.path, relativePath });
        }
      }
    } catch (_) {}
  }

  // ── Folder Picker ─────────────────────────────────────────────

  async openFolderPicker(): Promise<void> {
    this.showFolderPicker = true;
    this.folderSearch = '';
    if (this.workspaceFolders.length === 0) {
      await this.loadWorkspaceFolders();
    }
    setTimeout(() => this.folderSearchInputRef?.nativeElement.focus(), 0);
  }

  closeFolderPicker(): void {
    this.showFolderPicker = false;
    this.folderSearch = '';
  }

  addContextFolder(folder: ContextFolder): void {
    if (!this.contextFolders.find(f => f.path === folder.path)) {
      this.contextFolders.push({ ...folder });
    }
    this.closeFolderPicker();
  }

  removeContextFolder(folderPath: string): void {
    this.contextFolders = this.contextFolders.filter(f => f.path !== folderPath);
  }

  private async loadWorkspaceFolders(): Promise<void> {
    this.isLoadingFolders = true;
    this.workspaceFolders = [];

    // Real workspace roots and their sub-folders
    for (const root of this.workspaceRoots) {
      const rootName = root.split(/[/\\]/).pop() || root;
      this.workspaceFolders.push({ path: root, name: rootName });
      await this.collectFolders(root, root, 0);
    }

    // Virtual workspace sub-roots (read from localStorage, same source as file explorer)
    try {
      const raw = localStorage.getItem('explorerState');
      if (raw) {
        const state = JSON.parse(raw);
        if (Array.isArray(state.virtualWorkspaces)) {
          for (const vws of state.virtualWorkspaces) {
            // Sub-root folders
            if (Array.isArray(vws.subRoots)) {
              for (const sr of vws.subRoots) {
                if (!sr.path || this.workspaceFolders.some(f => f.path === sr.path)) continue;
                const label = (vws.name || '') + '/' + (sr.path.split(/[/\\]/).pop() || sr.path);
                this.workspaceFolders.push({ path: sr.path, name: label });
                await this.collectFolders(sr.path, sr.path, 0);
              }
            }

            // Individual files — expose their parent directories
            if (Array.isArray(vws.files)) {
              for (const filePath of vws.files) {
                if (!filePath) continue;
                const sep = filePath.includes('/') ? '/' : '\\';
                const parts = filePath.split(sep);
                parts.pop(); // remove filename
                if (parts.length === 0) continue;
                const parentDir = parts.join(sep);
                if (this.workspaceFolders.some(f => f.path === parentDir)) continue;
                const dirName = (vws.name || '') + '/' + (parts[parts.length - 1] || parentDir);
                this.workspaceFolders.push({ path: parentDir, name: dirName });
                await this.collectFolders(parentDir, parentDir, 0);
              }
            }
          }
        }
      }
    } catch (_) {}

    this.isLoadingFolders = false;
  }

  private async collectFolders(rootPath: string, dirPath: string, depth: number): Promise<void> {
    if (depth > 6) return;
    try {
      const items = await this.electronService.getDirectoryContents(dirPath);
      for (const item of items) {
        if (item.isDirectory) {
          const relativePath = item.path
            .replace(rootPath, '')
            .replace(/^[/\\]/, '')
            .replace(/\\/g, '/');
          this.workspaceFolders.push({ path: item.path, name: relativePath });
          await this.collectFolders(rootPath, item.path, depth + 1);
        }
      }
    } catch (_) {}
  }

  private extractKeywords(text: string): string[] {
    return text.toLowerCase().split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  }

  /** Recursively discover all .md files under a directory using the existing getDirectoryContents IPC. */
  private async discoverMdFiles(
    rootPath: string, dirPath: string, depth: number,
    out: { name: string; path: string; relativePath: string }[]
  ): Promise<void> {
    if (depth > 6) return;
    try {
      const items = await this.electronService.getDirectoryContents(dirPath);
      for (const item of items) {
        if (item.isDirectory) {
          await this.discoverMdFiles(rootPath, item.path, depth + 1, out);
        } else if (/\.(md|markdown)$/i.test(item.name)) {
          const relativePath = item.path
            .replace(rootPath, '')
            .replace(/^[/\\]/, '')
            .replace(/\\/g, '/');
          out.push({ name: item.name, path: item.path, relativePath });
        }
      }
    } catch (_) {}
  }

  // ── Chat ─────────────────────────────────────────────────────

  async send(): Promise<void> {
    const text = this.promptText.trim();
    if (!text || this.isStreaming) return;

    this.error = '';
    // Snapshot history before pushing the current user message
    const history: AiChatMessage[] = this.messages.map(m => ({ role: m.role, content: m.content }));
    this.messages.push({ role: 'user', content: text });
    this.promptText = '';
    this.isStreaming = true;
    this.streamingText = '';
    this.userScrolledUp = false; // always follow a new conversation turn
    this.shouldScrollToBottom = true;

    const contextParts: string[] = [];

    if (this.includeFileContent && this.currentContent.trim()) {
      contextParts.push(`Current file:\n\`\`\`\n${this.currentContent}\n\`\`\``);
    }

    for (const file of this.contextFiles) {
      if (file.content !== undefined) {
        contextParts.push(`File "${file.relativePath}":\n\`\`\`\n${file.content}\n\`\`\``);
      }
    }

    // Gather context from attached folders
    if (this.contextFolders.length > 0) {
      this.isSearchingFolders = true;
      try {
        const keywords = this.extractKeywords(text);
        for (const folder of this.contextFolders) {
          // Discover all .md files using existing getDirectoryContents IPC
          const allFiles: { name: string; path: string; relativePath: string }[] = [];
          await this.discoverMdFiles(folder.path, folder.path, 0, allFiles);

          // Always tell the AI the full file listing
          const listing = allFiles.map(f => f.relativePath).join('\n');
          contextParts.push(`Folder "${folder.name}" contains ${allFiles.length} markdown file(s):\n${listing}`);

          // For small folders (≤20 files), send all file contents directly.
          // For larger folders, use keyword search to pick the most relevant files.
          const SMALL_FOLDER_THRESHOLD = 20;
          if (allFiles.length <= SMALL_FOLDER_THRESHOLD) {
            for (const file of allFiles) {
              try {
                const content = await this.electronService.readFile(file.path);
                contextParts.push(`File "${file.relativePath}" (from ${folder.name}):\n\`\`\`\n${content}\n\`\`\``);
              } catch (_) {}
            }
          } else if (keywords.length > 0) {
            const matches = await this.electronService.grepMdFiles(folder.path, keywords, 10);
            for (const file of matches) {
              contextParts.push(`File "${file.relativePath}" (from ${folder.name}):\n\`\`\`\n${file.content}\n\`\`\``);
            }
          }
        }
      } catch (err) {
        console.error('Folder context error:', err);
      } finally {
        this.isSearchingFolders = false;
      }
    }

    const prompt = contextParts.length > 0
      ? contextParts.join('\n\n') + '\n\n' + text
      : text;

    this.streamSub = this.aiService.stream({
      provider: this.activeProvider,
      prompt,
      systemPrompt: 'You are a markdown document assistant. You help users with two things: (1) questions about the documents they provide — summarizing, analyzing, or answering questions about their content; (2) markdown syntax and formatting — explaining how to write tables, headings, code blocks, links, and any other markdown features. If the user asks about anything outside these two areas, politely decline and explain what you can help with.',
      history,
    }).subscribe({
      next: (chunk) => {
        if (chunk.type === 'chunk' && chunk.text) {
          this.streamingText += chunk.text;
          this.shouldScrollToBottom = true;
        }
      },
      error: (err: Error) => {
        this.isStreaming = false;
        this.error = err.message || 'Stream error';
        if (this.streamingText) {
          this.messages.push({ role: 'assistant', content: this.streamingText });
          this.streamingText = '';
        }
        this.shouldScrollToBottom = true;
      },
      complete: () => {
        this.isStreaming = false;
        if (this.streamingText) {
          this.messages.push({ role: 'assistant', content: this.streamingText });
          this.streamingText = '';
        }
        this.shouldScrollToBottom = true;
      },
    });
  }

  stop(): void {
    this.streamSub?.unsubscribe();
    this.isStreaming = false;
    if (this.streamingText) {
      this.messages.push({ role: 'assistant', content: this.streamingText + '\n\n*(stopped)*' });
      this.streamingText = '';
    }
    this.shouldScrollToBottom = true;
  }

  insert(content: string): void {
    this.insertText.emit(content);
  }

  clearChat(): void {
    this.stop();
    this.messages = [];
    this.streamingText = '';
    this.error = '';
  }

  private scrollToBottom(): void {
    const el = this.messagesContainerRef?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
