import {
  Component, Input, Output, EventEmitter, OnDestroy,
  ViewChild, ElementRef, AfterViewChecked
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import { Marked } from 'marked';
import hljs from 'highlight.js';
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

  private streamSub?: Subscription;
  private shouldScrollToBottom = false;

  constructor(
    private aiService: AiService,
    private aiSettingsService: AiSettingsService,
    private electronService: ElectronService,
    private sanitizer: DomSanitizer
  ) {}

  renderMarkdown(content: string): SafeHtml {
    const html = panelMarked.parse(content) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
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

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.shouldScrollToBottom = false;
      this.scrollToBottom();
    }
  }

  ngOnDestroy(): void {
    this.streamSub?.unsubscribe();
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  // ── File Picker ──────────────────────────────────────────────

  async openFilePicker(): Promise<void> {
    this.showFilePicker = true;
    this.fileSearch = '';
    if (this.workspaceFiles.length === 0 && this.workspaceRoots.length > 0) {
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
    for (const root of this.workspaceRoots) {
      await this.collectMdFiles(root, root, 0);
    }
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

  // ── Chat ─────────────────────────────────────────────────────

  send(): void {
    const text = this.promptText.trim();
    if (!text || this.isStreaming) return;

    this.error = '';
    // Snapshot history before pushing the current user message
    const history: AiChatMessage[] = this.messages.map(m => ({ role: m.role, content: m.content }));
    this.messages.push({ role: 'user', content: text });
    this.promptText = '';
    this.isStreaming = true;
    this.streamingText = '';
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
