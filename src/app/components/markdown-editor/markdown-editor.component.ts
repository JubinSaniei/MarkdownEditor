import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit, OnChanges, OnDestroy, HostListener, SimpleChanges } from '@angular/core';
import { Subscription } from 'rxjs';
import hljs from 'highlight.js';
import { AiService } from '../../services/ai.service';
import { AiSettingsService } from '../../services/ai-settings.service';

@Component({
  selector: 'app-markdown-editor',
  templateUrl: './markdown-editor.component.html',
  styleUrls: ['./markdown-editor.component.scss'],
  standalone: false
})
export class MarkdownEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() content: string = '';
  @Input() readOnly = false;
  @Output() contentChange = new EventEmitter<string>();
  @ViewChild('editor') editorElement!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('highlightBackdrop') highlightBackdrop!: ElementRef<HTMLDivElement>;
  @ViewChild('lineNumbers') lineNumbersEl!: ElementRef<HTMLDivElement>;
  @ViewChild('cheatsheetPanel') cheatsheetPanelEl!: ElementRef<HTMLDivElement>;
  @ViewChild('cheatsheetBtn') cheatsheetBtnEl!: ElementRef<HTMLButtonElement>;
  @ViewChild('inlineAiInput') inlineAiInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('searchOverlay') searchOverlayEl?: ElementRef<HTMLDivElement>;

  showCheatsheet = false;
  spellcheckEnabled = false;

  inlineAi: {
    visible: boolean;
    prompt: string;
    isStreaming: boolean;
    streamingText: string;
    previewText: string | null;
    selStart: number;
    selEnd: number;
    originalText: string;
    error: string;
  } = {
    visible: false,
    prompt: '',
    isStreaming: false,
    streamingText: '',
    previewText: null,
    selStart: 0,
    selEnd: 0,
    originalText: '',
    error: '',
  };

  readonly editChips = [
    { label: 'Fix grammar',   prompt: 'Fix grammar and spelling' },
    { label: 'Make shorter',  prompt: 'Make this more concise' },
    { label: 'Make longer',   prompt: 'Expand this with more detail' },
    { label: 'Rephrase',      prompt: 'Rephrase in different words' },
    { label: 'To bullets',    prompt: 'Convert to a bullet list' },
  ];

  readonly generateChips = [
    { label: 'Continue',      prompt: 'Continue writing from here' },
    { label: 'Add example',   prompt: 'Add a practical example' },
    { label: 'Add table',     prompt: 'Create a markdown table here' },
    { label: 'Summarize doc', prompt: 'Write a brief summary of this document' },
  ];

  promptHistory: string[] = [];
  private historyIndex = -1;

  private resizeObserver: ResizeObserver | null = null;
  private inlineAiSub?: Subscription;
  private syntaxRafId = 0;
  private _cachedLineCount = 0;
  private _cachedLineNumberList: number[] = [];
  private _cachedContent: string = '';
  private lastHighlightQuery: string = '';
  private lastHighlightCount: number = 0;

  constructor(
    private aiService: AiService,
    private aiSettingsService: AiSettingsService
  ) {}

  get lineNumberList(): number[] {
    if (this.content !== this._cachedContent) {
      this._cachedContent = this.content;
      const count = (this.content || '').split('\n').length;
      if (count !== this._cachedLineCount) {
        this._cachedLineCount = count;
        this._cachedLineNumberList = Array.from({ length: count }, (_, i) => i + 1);
      }
    }
    return this._cachedLineNumberList;
  }

  trackByNumber(_: number, n: number): number { return n; }

  ngAfterViewInit() {
    if (this.editorElement && this.highlightBackdrop) {
      this.editorElement.nativeElement.addEventListener('scroll', () => {
        this.syncScroll();
        if (this.lineNumbersEl) {
          this.lineNumbersEl.nativeElement.scrollTop = this.editorElement.nativeElement.scrollTop;
        }
        // Re-highlight for new viewport range on scroll
        this.scheduleSyntaxUpdate();
      });

      // Match the backdrop width to the textarea's content width (excludes scrollbar)
      // whenever the textarea resizes (window resize, split-pane drag, etc.).
      this.resizeObserver = new ResizeObserver(() => this.syncBackdropWidth());
      this.resizeObserver.observe(this.editorElement.nativeElement);

      // After fonts load, copy the textarea's computed text properties to the
      // backdrop so there's zero sub-pixel drift between <textarea> and <div>.
      document.fonts.ready.then(() => {
        this.syncBackdropStyles();
        this.syncBackdropWidth();
      });

      this.updateSyntaxBackdrop();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['content']) {
      this.scheduleSyntaxUpdate();
    }
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
    this.inlineAiSub?.unsubscribe();
    if (this.syntaxRafId) cancelAnimationFrame(this.syntaxRafId);
  }

  // ── Scroll / layout sync ─────────────────────────────────────

  /** Move the backdrop and search overlay via CSS transform so they stay aligned with the textarea. */
  private syncScroll() {
    if (!this.editorElement || !this.highlightBackdrop) return;
    const ta = this.editorElement.nativeElement;
    const t = `translateY(${-ta.scrollTop}px)`;
    this.highlightBackdrop.nativeElement.style.transform = t;
    if (this.searchOverlayEl) this.searchOverlayEl.nativeElement.style.transform = t;
  }

  /** Set the backdrop and search overlay width to the textarea's clientWidth (which excludes the scrollbar). */
  private syncBackdropWidth() {
    if (!this.editorElement || !this.highlightBackdrop) return;
    const ta = this.editorElement.nativeElement;
    const w = ta.clientWidth + 'px';
    this.highlightBackdrop.nativeElement.style.width = w;
    if (this.searchOverlayEl) this.searchOverlayEl.nativeElement.style.width = w;
  }

  /** Copy computed text properties from the textarea to the backdrop and search overlay. */
  private syncBackdropStyles() {
    if (!this.editorElement || !this.highlightBackdrop) return;
    const cs = window.getComputedStyle(this.editorElement.nativeElement);
    for (const el of [this.highlightBackdrop.nativeElement, this.searchOverlayEl?.nativeElement]) {
      if (!el) continue;
      el.style.lineHeight   = cs.lineHeight;
      el.style.fontFamily   = cs.fontFamily;
      el.style.fontSize     = cs.fontSize;
      el.style.paddingTop    = cs.paddingTop;
      el.style.paddingRight  = cs.paddingRight;
      el.style.paddingBottom = cs.paddingBottom;
      el.style.paddingLeft   = cs.paddingLeft;
    }
  }

  // ── Content ──────────────────────────────────────────────────

  onContentChange(event: any) {
    this.content = event.target.value;
    this.contentChange.emit(this.content);
    this.scheduleSyntaxUpdate();
    // Invalidate search overlay cache since match positions may have shifted
    this.lastHighlightQuery = '';
    this.lastHighlightCount = 0;
  }

  onEditorKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && this.inlineAi.visible) {
      event.preventDefault();
      this.discardInline();
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl) return;
    switch (event.key) {
      case 'b': event.preventDefault(); this.fmtBold();       return;
      case 'i': event.preventDefault(); this.fmtItalic();     return;
      case 'k': event.preventDefault(); this.fmtLink();       return;
      case '`': event.preventDefault(); this.fmtInlineCode(); return;
      case 'A':
        if (event.shiftKey && !this.readOnly) { event.preventDefault(); this.triggerInlineAi(); }
        return;
    }
  }

  // ── Formatting helpers ───────────────────────────────────────

  /** Apply a new textarea value, restore cursor/selection, and emit to parent.
   *  Uses execCommand('insertText') so the change lands on the native undo stack
   *  and Ctrl+Z works as expected after any toolbar action. */
  private applyFormat(newValue: string, selStart: number, selEnd: number) {
    const ta = this.editorElement.nativeElement;
    const scrollTop = ta.scrollTop;
    ta.focus();
    ta.select();
    // execCommand is deprecated but remains fully supported in Chromium / Electron
    // and is the only reliable way to push changes onto the textarea's undo stack.
    document.execCommand('insertText', false, newValue);
    ta.setSelectionRange(selStart, selEnd);
    ta.scrollTop = scrollTop;
    this.content = newValue;
    this.contentChange.emit(newValue);
  }

  /**
   * Wrap the current selection with `before` and `after` markers.
   * If the selection is already wrapped, remove the markers (toggle).
   * If nothing is selected, insert empty markers with cursor placed inside.
   */
  private wrapSelection(before: string, after: string) {
    const ta = this.editorElement.nativeElement;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;
    const sel = v.substring(s, e);
    const bLen = before.length;
    const aLen = after.length;

    // Already wrapped — markers sit immediately outside the selection
    if (s >= bLen && v.substring(s - bLen, s) === before && v.substring(e, e + aLen) === after) {
      const nv = v.substring(0, s - bLen) + sel + v.substring(e + aLen);
      this.applyFormat(nv, s - bLen, e - bLen);
      return;
    }

    if (sel) {
      const nv = v.substring(0, s) + before + sel + after + v.substring(e);
      this.applyFormat(nv, s + bLen, e + bLen);
    } else {
      const nv = v.substring(0, s) + before + after + v.substring(s);
      this.applyFormat(nv, s + bLen, s + bLen);
    }
  }

  /**
   * Add or remove a fixed prefix on every line touched by the selection.
   * Removes if all covered lines already start with the prefix; adds otherwise.
   */
  private toggleLinePrefix(prefix: string) {
    const ta = this.editorElement.nativeElement;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;

    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    // If selection ends exactly at the start of a new line, exclude that line
    const adjustedEnd = e > s && v[e - 1] === '\n' ? e - 1 : e;
    const lineEnd = (() => { const i = v.indexOf('\n', adjustedEnd); return i === -1 ? v.length : i; })();

    const chunk = v.substring(lineStart, lineEnd);
    const lines = chunk.split('\n');
    const allHave = lines.every(l => l.startsWith(prefix));

    if (allHave) {
      const newChunk = lines.map(l => l.substring(prefix.length)).join('\n');
      const removed = chunk.length - newChunk.length;
      const nv = v.substring(0, lineStart) + newChunk + v.substring(lineEnd);
      this.applyFormat(nv, Math.max(lineStart, s - prefix.length), Math.max(lineStart, e - removed));
    } else {
      const newChunk = lines.map(l => l.startsWith(prefix) ? l : prefix + l).join('\n');
      const added = newChunk.length - chunk.length;
      const nv = v.substring(0, lineStart) + newChunk + v.substring(lineEnd);
      const firstLineGain = lines[0].startsWith(prefix) ? 0 : prefix.length;
      this.applyFormat(nv, s + firstLineGain, e + added);
    }
  }

  /** Numbered-list variant of toggleLinePrefix (handles variable-width numbers). */
  private toggleOrderedList() {
    const ta = this.editorElement.nativeElement;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;

    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const adjustedEnd = e > s && v[e - 1] === '\n' ? e - 1 : e;
    const lineEnd = (() => { const i = v.indexOf('\n', adjustedEnd); return i === -1 ? v.length : i; })();

    const chunk = v.substring(lineStart, lineEnd);
    const lines = chunk.split('\n');
    const allOrdered = lines.every(l => /^\d+\.\s/.test(l));

    if (allOrdered) {
      const newChunk = lines.map(l => l.replace(/^\d+\.\s/, '')).join('\n');
      const removed = chunk.length - newChunk.length;
      const firstPfxLen = (lines[0].match(/^\d+\.\s/) || [''])[0].length;
      const nv = v.substring(0, lineStart) + newChunk + v.substring(lineEnd);
      this.applyFormat(nv, Math.max(lineStart, s - firstPfxLen), Math.max(lineStart, e - removed));
    } else {
      const newChunk = lines.map((l, i) => /^\d+\.\s/.test(l) ? l : `${i + 1}. ${l}`).join('\n');
      const added = newChunk.length - chunk.length;
      const firstLineGain = /^\d+\.\s/.test(lines[0]) ? 0 : `${1}. `.length;
      const nv = v.substring(0, lineStart) + newChunk + v.substring(lineEnd);
      this.applyFormat(nv, s + firstLineGain, e + added);
    }
  }

  // ── Public formatting actions ────────────────────────────────

  fmtBold()       { this.wrapSelection('**', '**'); }
  fmtItalic()     { this.wrapSelection('*', '*'); }
  fmtStrike()     { this.wrapSelection('~~', '~~'); }
  fmtInlineCode() { this.wrapSelection('`', '`'); }

  fmtHeading(level: number) {
    const prefix = '#'.repeat(level) + ' ';
    const ta = this.editorElement.nativeElement;
    const s = ta.selectionStart;
    const v = ta.value;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const rawEnd = v.indexOf('\n', s);
    const lineEnd = rawEnd === -1 ? v.length : rawEnd;
    const line = v.substring(lineStart, lineEnd);
    const m = line.match(/^(#{1,6}) /);

    if (m) {
      if (m[1] === '#'.repeat(level)) {
        // Same level → remove heading
        const newLine = line.substring(m[0].length);
        const nv = v.substring(0, lineStart) + newLine + v.substring(lineEnd);
        const nc = Math.max(lineStart, s - m[0].length);
        this.applyFormat(nv, nc, nc);
      } else {
        // Different level → replace
        const newLine = prefix + line.substring(m[0].length);
        const nv = v.substring(0, lineStart) + newLine + v.substring(lineEnd);
        const nc = s + (prefix.length - m[0].length);
        this.applyFormat(nv, nc, nc);
      }
    } else {
      const nv = v.substring(0, lineStart) + prefix + line + v.substring(lineEnd);
      const nc = s + prefix.length;
      this.applyFormat(nv, nc, nc);
    }
  }

  fmtBlockquote()    { this.toggleLinePrefix('> '); }
  fmtUnorderedList() { this.toggleLinePrefix('- '); }
  fmtOrderedList()   { this.toggleOrderedList(); }
  fmtTaskList()      { this.toggleLinePrefix('- [ ] '); }

  fmtCodeBlock() {
    const ta = this.editorElement.nativeElement;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;
    const sel = v.substring(s, e);
    const insert = '```\n' + (sel || '') + '\n```';
    const nv = v.substring(0, s) + insert + v.substring(e);
    // Place cursor right after the opening ``` so the language can be typed
    this.applyFormat(nv, s + 3, s + 3);
  }

  fmtHR() {
    const ta = this.editorElement.nativeElement;
    const s = ta.selectionStart;
    const v = ta.value;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const pre = lineStart > 0 ? '\n---\n\n' : '---\n\n';
    const nv = v.substring(0, lineStart) + pre + v.substring(lineStart);
    const nc = lineStart + pre.length;
    this.applyFormat(nv, nc, nc);
  }

  fmtLink() {
    const ta = this.editorElement.nativeElement;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;
    const text = v.substring(s, e) || 'link text';
    const insert = `[${text}](url)`;
    const nv = v.substring(0, s) + insert + v.substring(e);
    const urlStart = s + 1 + text.length + 2; // after [text](
    this.applyFormat(nv, urlStart, urlStart + 3); // select "url"
  }

  fmtImage() {
    const ta = this.editorElement.nativeElement;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;
    const alt = v.substring(s, e) || 'alt text';
    const insert = `![${alt}](url)`;
    const nv = v.substring(0, s) + insert + v.substring(e);
    const urlStart = s + 2 + alt.length + 2; // after ![alt](
    this.applyFormat(nv, urlStart, urlStart + 3); // select "url"
  }

  fmtTable() {
    const ta = this.editorElement.nativeElement;
    const s = ta.selectionStart;
    const v = ta.value;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const pre = s > lineStart ? '\n' : '';
    const table =
      '| Header 1 | Header 2 | Header 3 |\n' +
      '| --- | --- | --- |\n' +
      '| Cell | Cell | Cell |\n' +
      '| Cell | Cell | Cell |';
    const insert = pre + table + '\n';
    const nv = v.substring(0, s) + insert + v.substring(s);
    // Select "Header 1" so the user can start typing immediately
    const h1Start = s + pre.length + 2;
    this.applyFormat(nv, h1Start, h1Start + 8);
  }

  // ── Inline AI ─────────────────────────────────────────────────

  triggerInlineAi(): void {
    const ta = this.editorElement?.nativeElement;
    if (!ta) return;
    const selStart = ta.selectionStart;
    const selEnd   = ta.selectionEnd;
    this.inlineAi = {
      visible: true,
      prompt: '',
      isStreaming: false,
      streamingText: '',
      previewText: null,
      selStart,
      selEnd,
      originalText: this.content.substring(selStart, selEnd),
      error: '',
    };
    this.historyIndex = -1;
    setTimeout(() => this.inlineAiInputRef?.nativeElement.focus(), 0);
  }

  sendChip(prompt: string): void {
    this.inlineAi.prompt = prompt;
    this.sendInlineAi();
  }

  sendInlineAi(): void {
    const prompt = this.inlineAi.prompt.trim();
    if (!prompt || this.inlineAi.isStreaming) return;

    const { selStart, selEnd, originalText, previewText } = this.inlineAi;
    const hasSelection = selStart !== selEnd;
    const isRefining   = previewText !== null;
    const ctx          = this.getSurroundingLines(selStart, selEnd);

    // Update history (deduplicate, cap at 20)
    this.promptHistory = [prompt, ...this.promptHistory.filter(h => h !== prompt)].slice(0, 20);
    this.historyIndex  = -1;

    let fullPrompt: string;
    let systemPrompt: string;

    if (hasSelection) {
      const parts: string[] = [];
      if (ctx.before) parts.push(`Context before:\n\`\`\`\n${ctx.before}\n\`\`\``);
      parts.push(`Selected text:\n\`\`\`\n${originalText}\n\`\`\``);
      if (ctx.after)  parts.push(`Context after:\n\`\`\`\n${ctx.after}\n\`\`\``);
      if (isRefining) parts.push(`Previous suggestion:\n\`\`\`\n${previewText}\n\`\`\``);
      parts.push(`Instruction: ${prompt}`);
      fullPrompt   = parts.join('\n\n');
      systemPrompt = 'You are a markdown document assistant. The user wants to transform the selected markdown text. Apply the requested transformation and return ONLY the modified markdown text, with no explanations, preamble, or wrapper text.';
    } else {
      const parts: string[] = [];
      if (ctx.before) parts.push(`Context before cursor:\n\`\`\`\n${ctx.before}\n\`\`\``);
      if (ctx.after)  parts.push(`Context after cursor:\n\`\`\`\n${ctx.after}\n\`\`\``);
      if (isRefining) parts.push(`Previous suggestion:\n\`\`\`\n${previewText}\n\`\`\``);
      parts.push(prompt);
      fullPrompt   = parts.join('\n\n');
      systemPrompt = 'You are a markdown document assistant. Generate the requested markdown content. Return ONLY the markdown text, with no explanations or preamble.';
    }

    this.inlineAi.isStreaming  = true;
    this.inlineAi.streamingText = '';
    this.inlineAi.previewText  = null;
    this.inlineAi.error        = '';
    this.inlineAi.prompt       = '';

    this.inlineAiSub?.unsubscribe();
    this.inlineAiSub = this.aiService.stream({
      provider: this.aiSettingsService.snapshot.activeProvider,
      prompt: fullPrompt,
      systemPrompt,
    }).subscribe({
      next: (chunk) => {
        if (chunk.type === 'chunk' && chunk.text) {
          this.inlineAi.streamingText += chunk.text;
        }
      },
      error: (err: Error) => {
        this.inlineAi.isStreaming = false;
        this.inlineAi.error = err.message || 'Stream error';
        if (this.inlineAi.streamingText) {
          this.inlineAi.previewText = this.inlineAi.streamingText;
          this.inlineAi.streamingText = '';
        }
      },
      complete: () => {
        this.inlineAi.isStreaming = false;
        this.inlineAi.previewText = this.inlineAi.streamingText;
        this.inlineAi.streamingText = '';
      },
    });
  }

  onInlineAiKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.discardInline();
        break;
      case 'Tab':
        if (this.inlineAi.previewText !== null) {
          event.preventDefault();
          this.acceptInline();
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (!this.inlineAi.isStreaming) {
          if (this.inlineAi.previewText !== null && !this.inlineAi.prompt.trim()) {
            this.acceptInline();
          } else {
            this.sendInlineAi();
          }
        }
        break;
      case 'ArrowUp':
        if (this.promptHistory.length > 0) {
          event.preventDefault();
          this.historyIndex = Math.min(this.historyIndex + 1, this.promptHistory.length - 1);
          this.inlineAi.prompt = this.promptHistory[this.historyIndex];
        }
        break;
      case 'ArrowDown':
        event.preventDefault();
        if (this.historyIndex > 0) {
          this.historyIndex--;
          this.inlineAi.prompt = this.promptHistory[this.historyIndex];
        } else {
          this.historyIndex = -1;
          this.inlineAi.prompt = '';
        }
        break;
    }
  }

  acceptInline(): void {
    const text = this.inlineAi.previewText;
    if (text === null) return;
    const { selStart, selEnd } = this.inlineAi;
    const newValue = this.content.substring(0, selStart) + text + this.content.substring(selEnd);
    const cursorEnd = selStart + text.length;
    this.applyFormat(newValue, cursorEnd, cursorEnd);
    this.discardInline();
  }

  discardInline(): void {
    this.inlineAiSub?.unsubscribe();
    this.historyIndex = -1;
    this.inlineAi = {
      visible: false,
      prompt: '',
      isStreaming: false,
      streamingText: '',
      previewText: null,
      selStart: 0,
      selEnd: 0,
      originalText: '',
      error: '',
    };
    setTimeout(() => this.editorElement?.nativeElement.focus(), 0);
  }

  stopInline(): void {
    this.inlineAiSub?.unsubscribe();
    this.inlineAi.isStreaming = false;
    if (this.inlineAi.streamingText) {
      this.inlineAi.previewText = this.inlineAi.streamingText;
      this.inlineAi.streamingText = '';
    }
  }

  private getSurroundingLines(selStart: number, selEnd: number, count = 4): { before: string; after: string } {
    const lines = this.content.split('\n');
    let pos = 0;
    let startLine = 0;
    let endLine   = lines.length - 1;
    let foundStart = false;
    let foundEnd   = false;
    for (let i = 0; i < lines.length; i++) {
      const lineEnd = pos + lines[i].length;
      if (!foundStart && selStart <= lineEnd) { startLine = i; foundStart = true; }
      if (!foundEnd   && selEnd   <= lineEnd) { endLine   = i; foundEnd   = true; break; }
      pos += lines[i].length + 1;
    }
    return {
      before: lines.slice(Math.max(0, startLine - count), startLine).join('\n'),
      after:  lines.slice(endLine + 1, Math.min(lines.length, endLine + 1 + count)).join('\n'),
    };
  }

  // ── Search highlighting (public API for parent) ──────────────

  highlightSearchResults(query: string, results: any[], currentIndex: number) {
    if (!query || !results.length) {
      this.clearHighlights();
      return;
    }

    this.updateBackdropHighlights(query, results, currentIndex);

    if (currentIndex > 0 && currentIndex <= results.length && results[currentIndex - 1]) {
      this.scrollToResult(results[currentIndex - 1]);
    }
  }

  scrollToTop() {
    if (this.editorElement) {
      this.editorElement.nativeElement.scrollTop = 0;
      this.editorElement.nativeElement.setSelectionRange(0, 0);
    }
    if (this.lineNumbersEl) {
      this.lineNumbersEl.nativeElement.scrollTop = 0;
    }
  }

  /** Re-sync backdrop text properties after an external CSS change (e.g. font-size). */
  refreshBackdropStyles() {
    this.syncBackdropStyles();
    this.syncBackdropWidth();
  }

  /** Clear highlights without stealing focus. */
  clearSearchHighlights() {
    this.clearHighlights();
  }

  /** Clear highlights and return focus to the editor. */
  closeSearch() {
    this.clearHighlights();
    if (this.editorElement) {
      this.editorElement.nativeElement.focus();
    }
  }

  // ── Cheat Sheet ──────────────────────────────────────────────

  toggleCheatsheet() {
    this.showCheatsheet = !this.showCheatsheet;
  }

  toggleSpellcheck() {
    this.spellcheckEnabled = !this.spellcheckEnabled;
  }

  @HostListener('document:mousedown', ['$event'])
  onDocMouseDown(event: MouseEvent) {
    if (!this.showCheatsheet) return;
    const target = event.target as Node;
    const panel = this.cheatsheetPanelEl?.nativeElement;
    const btn   = this.cheatsheetBtnEl?.nativeElement;
    if (panel && !panel.contains(target) && btn && !btn.contains(target)) {
      this.showCheatsheet = false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  private updateBackdropHighlights(query: string, results: any[], currentIndex: number) {
    if (!this.searchOverlayEl || !this.editorElement) return;

    const overlay = this.searchOverlayEl.nativeElement;

    if (!query || results.length === 0) {
      overlay.innerHTML = '';
      this.lastHighlightQuery = '';
      this.lastHighlightCount = 0;
      return;
    }

    // If query and result count haven't changed, just move the .current marker
    // instead of rebuilding the entire overlay HTML (avoids expensive innerHTML).
    if (query === this.lastHighlightQuery && results.length === this.lastHighlightCount) {
      this.updateCurrentOverlayMarker(overlay, currentIndex);
      return;
    }

    this.lastHighlightQuery = query;
    this.lastHighlightCount = results.length;

    // Build the overlay HTML: the full content as transparent text with
    // search-highlight spans carrying only the yellow background.
    // Text color is transparent (set in CSS) so only the background shows,
    // leaving the syntax-colored backdrop fully visible underneath.
    const sortedMatches = [...results].sort((a, b) => a.start - b.start);
    let html = '';
    let lastEnd = 0;

    for (let i = 0; i < sortedMatches.length; i++) {
      const match = sortedMatches[i];
      const isCurrent = (i + 1) === currentIndex;

      html += this.escapeHtml(this.content.substring(lastEnd, match.start));

      const cls = isCurrent ? 'search-highlight current' : 'search-highlight';
      html += `<span class="${cls}">${this.escapeHtml(this.content.substring(match.start, match.end))}</span>`;

      lastEnd = match.end;
    }

    html += this.escapeHtml(this.content.substring(lastEnd));

    overlay.innerHTML = html;
    this.syncBackdropWidth();
    this.syncScroll();
  }

  private updateCurrentOverlayMarker(overlay: HTMLElement, currentIndex: number) {
    const oldCurrent = overlay.querySelector('.search-highlight.current');
    if (oldCurrent) oldCurrent.classList.remove('current');

    const highlights = overlay.querySelectorAll('.search-highlight');
    if (currentIndex > 0 && currentIndex <= highlights.length) {
      highlights[currentIndex - 1].classList.add('current');
    }
  }

  private scrollToResult(result: any) {
    if (!this.editorElement) return;

    const textarea = this.editorElement.nativeElement;
    textarea.setSelectionRange(result.start, result.end);

    const textBeforeSelection = textarea.value.substring(0, result.start);
    const lineNumber = (textBeforeSelection.match(/\n/g) || []).length;

    const style = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const targetScrollTop = lineNumber * lineHeight - textarea.clientHeight / 3;

    textarea.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth'
    });
  }

  private clearHighlights() {
    if (this.searchOverlayEl) this.searchOverlayEl.nativeElement.innerHTML = '';
    this.lastHighlightQuery = '';
    this.lastHighlightCount = 0;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Syntax highlighting ───────────────────────────────────────

  private scheduleSyntaxUpdate(): void {
    if (this.syntaxRafId) cancelAnimationFrame(this.syntaxRafId);
    this.syntaxRafId = requestAnimationFrame(() => {
      this.syntaxRafId = 0;
      this.updateSyntaxBackdrop();
    });
  }

  private updateSyntaxBackdrop(): void {
    if (!this.highlightBackdrop) return;
    const html = this.syntaxHighlight(this.content || '');
    this.highlightBackdrop.nativeElement.innerHTML = html;
    this.syncBackdropWidth();
    this.syncScroll();
  }

  /**
   * Returns the [firstVisible, lastVisible] line range currently shown in the
   * textarea viewport, plus a buffer of VIEWPORT_BUFFER lines on each side.
   */
  private static readonly VIEWPORT_BUFFER = 30;

  private getVisibleLineRange(totalLines: number): [number, number] {
    if (!this.editorElement) return [0, totalLines - 1];
    const ta = this.editorElement.nativeElement;
    const cs = window.getComputedStyle(ta);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    if (lineHeight <= 0) return [0, totalLines - 1];

    const scrollTop = ta.scrollTop;
    const viewHeight = ta.clientHeight;
    const firstVisible = Math.floor(scrollTop / lineHeight);
    const lastVisible = Math.ceil((scrollTop + viewHeight) / lineHeight);

    const buf = MarkdownEditorComponent.VIEWPORT_BUFFER;
    return [
      Math.max(0, firstVisible - buf),
      Math.min(totalLines - 1, lastVisible + buf)
    ];
  }

  private syntaxHighlight(text: string): string {
    const lines = text.replace(/\r/g, '').split('\n');
    const [vpStart, vpEnd] = this.getVisibleLineRange(lines.length);
    const out: string[] = [];
    let inFence = false;
    let fenceLang = '';
    let fenceBuffer: string[] = [];
    let fenceStartIdx = 0;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const esc = this.escapeHtml(raw);

      // Fenced code block fence line (``` or ~~~)
      if (/^(`{3,}|~{3,})/.test(raw)) {
        if (!inFence) {
          inFence = true;
          fenceLang = raw.replace(/^[`~]+/, '').trim().split(/\s/)[0] || '';
          fenceBuffer = [];
          fenceStartIdx = i + 1;
        } else {
          // Closing fence — flush the buffered code block
          this.flushCodeBlock(out, fenceBuffer, fenceLang, fenceStartIdx, vpStart, vpEnd);
          inFence = false;
          fenceLang = '';
          fenceBuffer = [];
        }
        if (i >= vpStart && i <= vpEnd) {
          out.push(`<span class="syn-fence">${esc}</span>`);
        } else {
          out.push(esc);
        }
        continue;
      }

      // Inside fenced code block — buffer the line
      if (inFence) {
        fenceBuffer.push(raw);
        continue;
      }

      // Off-viewport lines: skip expensive regex work, emit plain escaped text
      if (i < vpStart || i > vpEnd) {
        out.push(esc);
        continue;
      }

      // Headings (# through ######)
      const hm = raw.match(/^(#{1,6})([ \t]|$)/);
      if (hm) {
        const level = hm[1].length;
        out.push(`<span class="syn-h${level}"><span class="syn-marker">${this.escapeHtml(hm[1])}</span>${this.inlineHighlight(raw.slice(hm[1].length))}</span>`);
        continue;
      }

      // Horizontal rule (---, ***, ___ with optional spaces)
      if (/^[ \t]{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(raw) && raw.trim().length >= 3) {
        out.push(`<span class="syn-hr">${esc}</span>`);
        continue;
      }

      // Blockquote
      if (/^>/.test(raw)) {
        const markerMatch = raw.match(/^(>+[ \t]?)/);
        const marker = markerMatch ? markerMatch[1] : '>';
        const rest = raw.slice(marker.length);
        out.push(`<span class="syn-bq-marker">${this.escapeHtml(marker)}</span><span class="syn-blockquote">${this.inlineHighlight(rest)}</span>`);
        continue;
      }

      // Task list item (must come before unordered list)
      const taskM = raw.match(/^([ \t]*)([-*+][ \t])(\[[ xX]\])([ \t]?)(.*)/);
      if (taskM) {
        const [, indent, bullet, checkbox, sp, rest] = taskM;
        out.push(
          this.escapeHtml(indent) +
          `<span class="syn-list-marker">${this.escapeHtml(bullet)}</span>` +
          `<span class="syn-punct">${this.escapeHtml(checkbox)}</span>` +
          this.escapeHtml(sp) +
          this.inlineHighlight(rest)
        );
        continue;
      }

      // Unordered list item
      const ulM = raw.match(/^([ \t]*)([-*+])([ \t])(.*)/);
      if (ulM) {
        const [, indent, bullet, sp, rest] = ulM;
        out.push(
          this.escapeHtml(indent) +
          `<span class="syn-list-marker">${this.escapeHtml(bullet + sp)}</span>` +
          this.inlineHighlight(rest)
        );
        continue;
      }

      // Ordered list item
      const olM = raw.match(/^([ \t]*)(\d+\.)([ \t])(.*)/);
      if (olM) {
        const [, indent, num, sp, rest] = olM;
        out.push(
          this.escapeHtml(indent) +
          `<span class="syn-list-marker">${this.escapeHtml(num + sp)}</span>` +
          this.inlineHighlight(rest)
        );
        continue;
      }

      // Normal line
      out.push(this.inlineHighlight(raw));
    }

    // Unclosed fence at end of file — flush remaining buffered lines
    if (inFence && fenceBuffer.length > 0) {
      this.flushCodeBlock(out, fenceBuffer, fenceLang, fenceStartIdx, vpStart, vpEnd);
    }

    return out.join('\n');
  }

  /**
   * Highlight a buffered fenced code block with highlight.js and push
   * the result lines into the output array.
   */
  private flushCodeBlock(
    out: string[], buffer: string[], lang: string,
    startIdx: number, vpStart: number, vpEnd: number
  ): void {
    // Check if any part of the block is visible
    const endIdx = startIdx + buffer.length - 1;
    const anyVisible = endIdx >= vpStart && startIdx <= vpEnd;

    if (!anyVisible || buffer.length === 0) {
      // Off-viewport — emit plain escaped lines
      for (const line of buffer) {
        out.push(this.escapeHtml(line));
      }
      return;
    }

    // Run highlight.js on the whole block
    const code = buffer.join('\n');
    let highlighted: string;
    try {
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(code, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(code).value;
      }
    } catch (_) {
      highlighted = this.escapeHtml(code);
    }

    // Split back into lines and wrap each in a code-line span
    const hljsLines = highlighted.split('\n');
    for (let j = 0; j < hljsLines.length; j++) {
      const lineIdx = startIdx + j;
      if (lineIdx >= vpStart && lineIdx <= vpEnd) {
        out.push(`<span class="syn-code-line">${hljsLines[j]}</span>`);
      } else {
        out.push(this.escapeHtml(buffer[j] ?? ''));
      }
    }
  }

  private inlineHighlight(raw: string): string {
    // Step 1: extract inline code so its content is never re-processed
    const codes: string[] = [];
    let s = raw.replace(/`([^`\n]+)`/g, (_m, inner) => {
      codes.push(inner);
      return `\uE000${codes.length - 1}\uE001`;
    });

    // Step 2: HTML-escape the remaining text (placeholders survive untouched)
    s = this.escapeHtml(s);

    // Step 3: images before links to prevent `![` being matched as a link
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\n]*)\)/g,
      (_m, alt, url) =>
        `<span class="syn-punct">![</span><span class="syn-link-text">${alt}</span><span class="syn-punct">](</span><span class="syn-url">${url}</span><span class="syn-punct">)</span>`
    );

    s = s.replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g,
      (_m, text, url) =>
        `<span class="syn-punct">[</span><span class="syn-link-text">${text}</span><span class="syn-punct">](</span><span class="syn-url">${url}</span><span class="syn-punct">)</span>`
    );

    // Strikethrough (~~…~~)
    s = s.replace(/~~(.+?)~~/g,
      (_m, inner) =>
        `<span class="syn-marker">~~</span><span class="syn-strike">${inner}</span><span class="syn-marker">~~</span>`
    );

    // Bold (**…** then __…__)
    s = s.replace(/\*\*(.+?)\*\*/g,
      (_m, inner) =>
        `<span class="syn-marker">\*\*</span><span class="syn-bold">${inner}</span><span class="syn-marker">\*\*</span>`
    );
    s = s.replace(/__([^_\n]+)__/g,
      (_m, inner) =>
        `<span class="syn-marker">__</span><span class="syn-bold">${inner}</span><span class="syn-marker">__</span>`
    );

    // Italic (*…* then _…_) — exclude content with * or span tags to avoid false matches
    s = s.replace(/\*([^*\n<>]+)\*/g,
      (_m, inner) =>
        `<span class="syn-marker">\*</span><span class="syn-italic">${inner}</span><span class="syn-marker">\*</span>`
    );
    s = s.replace(/_([^_\n<>]+)_/g,
      (_m, inner) =>
        `<span class="syn-marker">_</span><span class="syn-italic">${inner}</span><span class="syn-marker">_</span>`
    );

    // Step 4: restore inline code
    s = s.replace(/\uE000(\d+)\uE001/g,
      (_m, idx) =>
        `<span class="syn-inline-code">\`${this.escapeHtml(codes[+idx])}\`</span>`
    );

    return s;
  }
}
