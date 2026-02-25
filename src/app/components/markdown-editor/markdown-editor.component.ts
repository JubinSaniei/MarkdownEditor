import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit, OnChanges, OnDestroy, HostListener, SimpleChanges } from '@angular/core';
import { Subscription } from 'rxjs';
import hljs from 'highlight.js';
import { AiService } from '../../services/ai.service';
import { AiSettingsService } from '../../services/ai-settings.service';

type InlineAiScope = 'selection' | 'section' | 'document';
type InlineAiMode = 'edit' | 'ask';

type DiffDecision = 'accepted' | 'rejected' | 'pending';

interface InlineDiffHunk {
  index: number;
  opStart: number;
  opEnd: number;
}

interface InlineDiffRow {
  hunkIndex: number;
  kind: 'del' | 'add';
  oldLineNo: number | null;
  newLineNo: number | null;
  oldHtml: string;
  newHtml: string;
}

interface InlineDiffOp {
  kind: 'eq' | 'del' | 'add';
  oldIdx?: number;
  newIdx?: number;
  oldText?: string;
  newText?: string;
  hunkIndex: number | null;
}

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
    mode: InlineAiMode;
    scope: InlineAiScope;
    hasInitialSelection: boolean;
    initialSelStart: number;
    initialSelEnd: number;
    anchorPos: number;
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
    mode: 'edit',
    scope: 'document',
    hasInitialSelection: false,
    initialSelStart: 0,
    initialSelEnd: 0,
    anchorPos: 0,
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
  private internalContentUpdate = false;
  diffIgnoreWhitespace = false;
  inlineDiffRows: InlineDiffRow[] = [];
  inlineDiffHunks: InlineDiffHunk[] = [];
  inlineDiffDecisions: DiffDecision[] = [];
  inlineDiffOps: InlineDiffOp[] = [];
  activeDiffHunkIndex = 0;
  diffAddedLines = 0;
  diffRemovedLines = 0;

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
      const changedExternally =
        !changes['content'].firstChange &&
        changes['content'].previousValue !== changes['content'].currentValue &&
        !this.internalContentUpdate;

      if (changedExternally && this.inlineAi.visible) {
        this.discardInline();
      }

      this.internalContentUpdate = false;
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
    this.internalContentUpdate = true;
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
    this.internalContentUpdate = true;
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
    this.inlineAiSub?.unsubscribe();
    this.inlineAiSub = undefined;
    const rawSelStart = ta.selectionStart;
    const rawSelEnd   = ta.selectionEnd;
    const hasUserSelection = rawSelStart !== rawSelEnd;
    const scope: InlineAiScope = hasUserSelection ? 'selection' : 'document';
    this.inlineAi = {
      visible: true,
      mode: 'edit',
      scope,
      hasInitialSelection: hasUserSelection,
      initialSelStart: rawSelStart,
      initialSelEnd: rawSelEnd,
      anchorPos: rawSelStart,
      prompt: '',
      isStreaming: false,
      streamingText: '',
      previewText: null,
      selStart: 0,
      selEnd: 0,
      originalText: '',
      error: '',
    };
    this.applyInlineScopeTarget();
    this.historyIndex = -1;
    setTimeout(() => this.inlineAiInputRef?.nativeElement.focus(), 0);
  }

  sendChip(prompt: string): void {
    this.inlineAi.prompt = prompt;
    this.sendInlineAi();
  }

  setInlineScope(scope: InlineAiScope): void {
    if (scope === 'selection' && !this.inlineAi.hasInitialSelection) return;
    if (this.inlineAi.scope === scope) return;
    this.inlineAi.scope = scope;
    this.applyInlineScopeTarget();
    setTimeout(() => this.inlineAiInputRef?.nativeElement.focus(), 0);
  }

  sendInlineAi(): void {
    const prompt = this.inlineAi.prompt.trim();
    if (!prompt || this.inlineAi.isStreaming) return;

    this.applyInlineScopeTarget();
    let { selStart, selEnd, originalText } = this.inlineAi;
    const { previewText } = this.inlineAi;

    // Allow line-targeted instructions without manual selection, e.g.
    // "add ... at the end of line 3" or "replace line 5 ...".
    let targetDescription = this.describeCurrentInlineScopeTarget();
    const lineTarget = this.resolveLineTargetFromPrompt(prompt);
    if (lineTarget) {
      // Explicit line-target instructions must override the previous
      // cursor/selection so edits land where the user asked.
      selStart = lineTarget.selStart;
      selEnd = lineTarget.selEnd;
      originalText = lineTarget.originalText;
      targetDescription = lineTarget.description;
      this.inlineAi.selStart = selStart;
      this.inlineAi.selEnd = selEnd;
      this.inlineAi.originalText = originalText;
    }

    const hasSelection = selStart !== selEnd;
    const mode: InlineAiMode = this.detectInlineMode(prompt);
    this.inlineAi.mode = mode;
    const isRefining   = previewText !== null;
    const ctx          = this.getSurroundingLines(selStart, selEnd);
    const docContext   = this.getDocumentContextForAi();

    // Update history (deduplicate, cap at 20)
    this.promptHistory = [prompt, ...this.promptHistory.filter(h => h !== prompt)].slice(0, 20);
    this.historyIndex  = -1;

    let fullPrompt: string;
    let systemPrompt: string;

    if (mode === 'ask') {
      const parts: string[] = [];
      parts.push(docContext);
      if (targetDescription) parts.push(`Target: ${targetDescription}`);
      if (ctx.before) parts.push(`Context before:\n\`\`\`\n${ctx.before}\n\`\`\``);
      if (hasSelection) parts.push(`Selected text:\n\`\`\`\n${originalText}\n\`\`\``);
      if (ctx.after)  parts.push(`Context after:\n\`\`\`\n${ctx.after}\n\`\`\``);
      if (isRefining) parts.push(`Previous answer:\n\`\`\`\n${previewText}\n\`\`\``);
      parts.push(`Question: ${prompt}`);
      fullPrompt = parts.join('\n\n');
      systemPrompt = 'You are a markdown-only assistant. The document is markdown and your answer must respect markdown semantics and terminology. Do not rewrite the document when answering questions. Return a clear direct answer only.';
    } else if (hasSelection) {
      const parts: string[] = [];
      parts.push(docContext);
      if (targetDescription) parts.push(`Target: ${targetDescription}`);
      if (ctx.before) parts.push(`Context before:\n\`\`\`\n${ctx.before}\n\`\`\``);
      parts.push(`Selected text:\n\`\`\`\n${originalText}\n\`\`\``);
      if (ctx.after)  parts.push(`Context after:\n\`\`\`\n${ctx.after}\n\`\`\``);
      if (isRefining) parts.push(`Previous suggestion:\n\`\`\`\n${previewText}\n\`\`\``);
      parts.push(`Instruction: ${prompt}`);
      fullPrompt   = parts.join('\n\n');
      systemPrompt = 'You are the user\'s dedicated editing agent for THIS markdown document. Markdown-only contract: preserve valid markdown syntax and structure; do not break heading hierarchy, list nesting, table column counts, fenced code blocks, links, or emphasis markers. Preserve document voice and formatting conventions. Modify only the provided selected text to satisfy the instruction. Return ONLY the replacement markdown for the selected text, with no explanations, preamble, code fences, or wrapper text.';
    } else {
      const parts: string[] = [];
      parts.push(docContext);
      if (targetDescription) parts.push(`Target insertion point: ${targetDescription}`);
      if (ctx.before) parts.push(`Context before cursor:\n\`\`\`\n${ctx.before}\n\`\`\``);
      if (ctx.after)  parts.push(`Context after cursor:\n\`\`\`\n${ctx.after}\n\`\`\``);
      if (isRefining) parts.push(`Previous suggestion:\n\`\`\`\n${previewText}\n\`\`\``);
      parts.push(`Instruction: ${prompt}`);
      fullPrompt   = parts.join('\n\n');
      systemPrompt = 'You are the user\'s dedicated editing agent for THIS markdown document. Markdown-only contract: produce valid markdown that fits the target location; do not break heading hierarchy, list nesting, table column counts, fenced code blocks, links, or emphasis markers. Preserve local tone and structure. Return ONLY the insertion markdown text, with no explanations, preamble, code fences, or wrapper text.';
    }

    const sentPrompt = prompt;
    this.inlineAi.isStreaming  = true;
    this.inlineAi.streamingText = '';
    this.inlineAi.previewText  = null;
    this.inlineAi.error        = '';
    this.inlineAi.prompt       = '';
    this.resetInlineDiffState();

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
          this.inlineAi.previewText = this.normalizeInlineOutput(this.inlineAi.streamingText);
          this.inlineAi.streamingText = '';
          this.prepareInlineDiffView();
        } else {
          this.inlineAi.prompt = sentPrompt;
        }
      },
      complete: () => {
        this.inlineAi.isStreaming = false;
        const result = this.normalizeInlineOutput(this.inlineAi.streamingText);
        if (result) {
          this.inlineAi.previewText = result;
        } else {
          this.inlineAi.error = 'No response generated.';
          this.inlineAi.prompt = sentPrompt;
        }
        this.inlineAi.streamingText = '';
        if (this.inlineAi.mode === 'edit') this.prepareInlineDiffView();
        else this.resetInlineDiffState();
        setTimeout(() => this.inlineAiInputRef?.nativeElement.focus(), 0);
      },
    });
  }

  @HostListener('document:keydown', ['$event'])
  onInlineAiGlobalKeyDown(event: KeyboardEvent): void {
    if (!this.inlineAi.visible || this.inlineAi.isStreaming) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const activeEl = document.activeElement as HTMLElement | null;
    const inputEl = this.inlineAiInputRef?.nativeElement;
    const inputFocused = !!(inputEl && activeEl === inputEl);

    // Let the input's own key handler decide when it's focused.
    if (inputFocused) return;

    if (this.isPrintableKey(event)) {
      event.preventDefault();
      this.inlineAi.prompt += event.key;
      setTimeout(() => this.inlineAiInputRef?.nativeElement.focus(), 0);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.discardInline();
      return;
    }

    if (this.inlineAi.mode === 'edit' && this.inlineAi.previewText !== null && !this.inlineAi.prompt.trim()) {
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        this.acceptInline();
        return;
      }
      if (event.key.toLowerCase() === 'j') {
        event.preventDefault();
        this.gotoNextDiffHunk();
        return;
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.gotoPreviousDiffHunk();
        return;
      }
      if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        this.acceptActiveHunk();
        return;
      }
      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        this.rejectActiveHunk();
      }
    }
  }

  onInlineAiKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.discardInline();
        break;
      case 'Tab':
        if (this.inlineAi.mode === 'edit' && this.inlineAi.previewText !== null) {
          event.preventDefault();
          this.acceptInline();
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (!this.inlineAi.isStreaming) {
          if (this.inlineAi.mode === 'edit' && this.inlineAi.previewText !== null && !this.inlineAi.prompt.trim()) {
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
    const text = this.getEffectiveInlinePreviewText();
    if (text === null) return;
    if (this.inlineAi.mode === 'ask') {
      this.discardInline();
      return;
    }
    const { selStart, selEnd } = this.inlineAi;
    const newValue = this.content.substring(0, selStart) + text + this.content.substring(selEnd);
    const cursorEnd = selStart + text.length;
    this.applyFormat(newValue, cursorEnd, cursorEnd);
    this.discardInline();
  }

  discardInline(): void {
    this.inlineAiSub?.unsubscribe();
    this.inlineAiSub = undefined;
    this.historyIndex = -1;
    this.inlineAi = {
      visible: false,
      mode: 'edit',
      scope: 'document',
      hasInitialSelection: false,
      initialSelStart: 0,
      initialSelEnd: 0,
      anchorPos: 0,
      prompt: '',
      isStreaming: false,
      streamingText: '',
      previewText: null,
      selStart: 0,
      selEnd: 0,
      originalText: '',
      error: '',
    };
    this.resetInlineDiffState();
    setTimeout(() => this.editorElement?.nativeElement.focus(), 0);
  }

  stopInline(): void {
    this.inlineAiSub?.unsubscribe();
    this.inlineAiSub = undefined;
    this.inlineAi.isStreaming = false;
    if (this.inlineAi.streamingText) {
      this.inlineAi.previewText = this.normalizeInlineOutput(this.inlineAi.streamingText);
      this.inlineAi.streamingText = '';
      if (this.inlineAi.mode === 'edit') this.prepareInlineDiffView();
      else this.resetInlineDiffState();
    }
  }

  private detectInlineMode(prompt: string): InlineAiMode {
    const q = prompt.trim().toLowerCase();
    if (!q) return 'edit';
    const askPattern = /\b(describe|explain|summari[sz]e|what\s+is|what\s+does|why|how)\b/i;
    if (askPattern.test(q) || q.endsWith('?')) return 'ask';
    return 'edit';
  }

  private isPrintableKey(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  private normalizeInlineOutput(text: string): string {
    if (!text) return '';
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    return fenced ? fenced[1] : text;
  }

  toggleDiffIgnoreWhitespace(): void {
    this.diffIgnoreWhitespace = !this.diffIgnoreWhitespace;
    this.prepareInlineDiffView();
  }

  gotoNextDiffHunk(): void {
    if (!this.inlineDiffHunks.length) return;
    this.activeDiffHunkIndex = (this.activeDiffHunkIndex + 1) % this.inlineDiffHunks.length;
  }

  gotoPreviousDiffHunk(): void {
    if (!this.inlineDiffHunks.length) return;
    this.activeDiffHunkIndex = (this.activeDiffHunkIndex - 1 + this.inlineDiffHunks.length) % this.inlineDiffHunks.length;
  }

  setActiveHunk(index: number): void {
    if (index < 0 || index >= this.inlineDiffHunks.length) return;
    this.activeDiffHunkIndex = index;
  }

  acceptHunk(index: number): void {
    if (index < 0 || index >= this.inlineDiffDecisions.length) return;
    this.inlineDiffDecisions[index] = 'accepted';
  }

  rejectHunk(index: number): void {
    if (index < 0 || index >= this.inlineDiffDecisions.length) return;
    this.inlineDiffDecisions[index] = 'rejected';
  }

  acceptActiveHunk(): void {
    this.acceptHunk(this.activeDiffHunkIndex);
  }

  rejectActiveHunk(): void {
    this.rejectHunk(this.activeDiffHunkIndex);
  }

  get acceptedHunkCount(): number {
    return this.inlineDiffDecisions.filter(d => d === 'accepted').length;
  }

  get hasDiffHunks(): boolean {
    return this.inlineDiffHunks.length > 0;
  }

  get activeHunkOneBased(): number {
    return this.inlineDiffHunks.length ? this.activeDiffHunkIndex + 1 : 0;
  }

  get activeHunkDecision(): DiffDecision {
    return this.inlineDiffDecisions[this.activeDiffHunkIndex] ?? 'pending';
  }

  get activeHunkRows(): InlineDiffRow[] {
    return this.getRowsForHunk(this.activeDiffHunkIndex);
  }

  get activeHunkAddedCount(): number {
    return this.getHunkAddedCount(this.activeDiffHunkIndex);
  }

  get activeHunkRemovedCount(): number {
    return this.getHunkRemovedCount(this.activeDiffHunkIndex);
  }

  applyAcceptedHunks(): void {
    const text = this.getAcceptedOnlyPreviewText();
    if (text === null) return;
    const { selStart, selEnd } = this.inlineAi;
    const newValue = this.content.substring(0, selStart) + text + this.content.substring(selEnd);
    const cursorEnd = selStart + text.length;
    this.applyFormat(newValue, cursorEnd, cursorEnd);
    this.discardInline();
  }

  acceptAllHunksAndApply(): void {
    if (!this.inlineDiffHunks.length) {
      this.acceptInline();
      return;
    }
    this.inlineDiffDecisions = this.inlineDiffDecisions.map(() => 'accepted');
    this.applyAcceptedHunks();
  }

  private getEffectiveInlinePreviewText(): string | null {
    if (this.inlineAi.previewText === null) return null;
    return this.inlineDiffDecisions.some(d => d === 'accepted')
      ? this.getAcceptedOnlyPreviewText()
      : this.inlineAi.previewText;
  }

  private getAcceptedOnlyPreviewText(): string | null {
    if (this.inlineAi.previewText === null) return null;
    const output: string[] = [];
    for (const op of this.inlineDiffOps) {
      if (op.kind === 'eq') {
        output.push(op.oldText ?? '');
        continue;
      }

      const decision = op.hunkIndex != null ? this.inlineDiffDecisions[op.hunkIndex] : 'pending';
      if (decision === 'accepted') {
        if (op.kind === 'add') output.push(op.newText ?? '');
      } else {
        if (op.kind === 'del') output.push(op.oldText ?? '');
      }
    }
    return output.join('\n');
  }

  private resetInlineDiffState(): void {
    this.inlineDiffRows = [];
    this.inlineDiffHunks = [];
    this.inlineDiffDecisions = [];
    this.inlineDiffOps = [];
    this.activeDiffHunkIndex = 0;
    this.diffAddedLines = 0;
    this.diffRemovedLines = 0;
  }

  private prepareInlineDiffView(): void {
    this.resetInlineDiffState();
    if (!this.inlineAi.previewText || this.inlineAi.selStart === this.inlineAi.selEnd) return;

    const oldLines = this.inlineAi.originalText.split('\n');
    const newLines = this.inlineAi.previewText.split('\n');
    const ops = this.computeLineOps(oldLines, newLines).map(op => ({ ...op, hunkIndex: null as number | null }));
    this.inlineDiffOps = ops;

    this.diffAddedLines = ops.filter(o => o.kind === 'add').length;
    this.diffRemovedLines = ops.filter(o => o.kind === 'del').length;

    const groups: Array<{ start: number; end: number }> = [];
    let i = 0;
    while (i < ops.length) {
      if (ops[i].kind === 'eq') {
        i++;
        continue;
      }
      const start = i;
      while (i < ops.length && ops[i].kind !== 'eq') i++;
      groups.push({ start, end: i });
    }

    groups.forEach((g, idx) => {
      const hunk: InlineDiffHunk = {
        index: idx,
        opStart: g.start,
        opEnd: g.end,
      };
      this.inlineDiffHunks.push(hunk);
      this.inlineDiffDecisions.push('pending');

      for (let j = g.start; j < g.end; j++) {
        const op = ops[j];
        if (op.kind === 'eq') continue;
        op.hunkIndex = idx;
        const row: InlineDiffRow = {
          hunkIndex: idx,
          kind: op.kind,
          oldLineNo: op.oldIdx != null ? op.oldIdx + 1 : null,
          newLineNo: op.newIdx != null ? op.newIdx + 1 : null,
          oldHtml: op.kind === 'del' ? this.escapeHtml(op.oldText || '') : '',
          newHtml: op.kind === 'add' ? this.escapeHtml(op.newText || '') : '',
        };
        this.inlineDiffRows.push(row);
      }
    });

    this.decorateWordDiffPairs();
  }

  getRowsForHunk(hunkIndex: number): InlineDiffRow[] {
    return this.inlineDiffRows.filter(r => r.hunkIndex === hunkIndex);
  }

  getHunkAddedCount(hunkIndex: number): number {
    return this.inlineDiffRows.filter(r => r.hunkIndex === hunkIndex && r.kind === 'add').length;
  }

  getHunkRemovedCount(hunkIndex: number): number {
    return this.inlineDiffRows.filter(r => r.hunkIndex === hunkIndex && r.kind === 'del').length;
  }

  private decorateWordDiffPairs(): void {
    for (let i = 0; i < this.inlineDiffRows.length - 1; i++) {
      const a = this.inlineDiffRows[i];
      const b = this.inlineDiffRows[i + 1];
      if (a.hunkIndex !== b.hunkIndex) continue;
      if (a.kind !== 'del' || b.kind !== 'add') continue;

      const oldText = this.inlineAi.originalText.split('\n')[(a.oldLineNo || 1) - 1] ?? '';
      const newText = this.inlineAi.previewText?.split('\n')[(b.newLineNo || 1) - 1] ?? '';
      const w = this.computeWordDiffHtml(oldText, newText);
      a.oldHtml = w.oldHtml;
      b.newHtml = w.newHtml;
      i++;
    }
  }

  private computeLineOps(oldLines: string[], newLines: string[]):
    Array<{ kind: 'eq' | 'del' | 'add'; oldIdx?: number; newIdx?: number; oldText?: string; newText?: string }> {
    const n = oldLines.length;
    const m = newLines.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (this.normalizeForDiff(oldLines[i]) === this.normalizeForDiff(newLines[j])) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    const ops: Array<{ kind: 'eq' | 'del' | 'add'; oldIdx?: number; newIdx?: number; oldText?: string; newText?: string }> = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (this.normalizeForDiff(oldLines[i]) === this.normalizeForDiff(newLines[j])) {
        ops.push({ kind: 'eq', oldIdx: i, newIdx: j, oldText: oldLines[i], newText: newLines[j] });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ kind: 'del', oldIdx: i, oldText: oldLines[i] });
        i++;
      } else {
        ops.push({ kind: 'add', newIdx: j, newText: newLines[j] });
        j++;
      }
    }
    while (i < n) { ops.push({ kind: 'del', oldIdx: i, oldText: oldLines[i] }); i++; }
    while (j < m) { ops.push({ kind: 'add', newIdx: j, newText: newLines[j] }); j++; }

    return ops;
  }

  private computeWordDiffHtml(oldText: string, newText: string): { oldHtml: string; newHtml: string } {
    const oldToks = this.tokenizeForWordDiff(oldText);
    const newToks = this.tokenizeForWordDiff(newText);
    const n = oldToks.length;
    const m = newToks.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (this.normalizeForDiff(oldToks[i]) === this.normalizeForDiff(newToks[j])) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    const oldParts: string[] = [];
    const newParts: string[] = [];
    while (i < n && j < m) {
      if (this.normalizeForDiff(oldToks[i]) === this.normalizeForDiff(newToks[j])) {
        const esc = this.escapeHtml(oldToks[i]);
        oldParts.push(esc);
        newParts.push(this.escapeHtml(newToks[j]));
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        oldParts.push(`<span class="iai-word-del">${this.escapeHtml(oldToks[i])}</span>`);
        i++;
      } else {
        newParts.push(`<span class="iai-word-add">${this.escapeHtml(newToks[j])}</span>`);
        j++;
      }
    }
    while (i < n) { oldParts.push(`<span class="iai-word-del">${this.escapeHtml(oldToks[i])}</span>`); i++; }
    while (j < m) { newParts.push(`<span class="iai-word-add">${this.escapeHtml(newToks[j])}</span>`); j++; }

    return { oldHtml: oldParts.join(''), newHtml: newParts.join('') };
  }

  private tokenizeForWordDiff(text: string): string[] {
    const tokens = text.match(/\s+|[^\s]+/g);
    return tokens ?? [];
  }

  private normalizeForDiff(text: string): string {
    if (!this.diffIgnoreWhitespace) return text;
    return text.replace(/\s+/g, ' ').trim();
  }

  private resolveLineTargetFromPrompt(prompt: string):
    { selStart: number; selEnd: number; originalText: string; description: string } | null {
    const text = this.content || '';
    const lines = text.split('\n');
    if (lines.length === 0) return null;

    const endMatch = prompt.match(/\b(?:at\s+)?(?:the\s+)?end\s+of\s+line\s*#?\s*(\d+)\b/i);
    if (endMatch) {
      const lineNo = Number(endMatch[1]);
      if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > lines.length) return null;
      const { end } = this.getLineBounds(lineNo);
      return { selStart: end, selEnd: end, originalText: '', description: `end of line ${lineNo}` };
    }

    const startMatch = prompt.match(/\b(?:at\s+)?(?:the\s+)?(?:start|beginning)\s+of\s+line\s*#?\s*(\d+)\b/i);
    if (startMatch) {
      const lineNo = Number(startMatch[1]);
      if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > lines.length) return null;
      const { start } = this.getLineBounds(lineNo);
      return { selStart: start, selEnd: start, originalText: '', description: `start of line ${lineNo}` };
    }

    const replaceMatch = prompt.match(/\b(?:replace|rewrite|improve|fix)\s+line\s*#?\s*(\d+)\b/i);
    if (replaceMatch) {
      const lineNo = Number(replaceMatch[1]);
      if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > lines.length) return null;
      const { start, end } = this.getLineBounds(lineNo);
      return {
        selStart: start,
        selEnd: end,
        originalText: text.substring(start, end),
        description: `entire line ${lineNo}`
      };
    }

    return null;
  }

  private getLineBounds(lineNumber: number): { start: number; end: number } {
    const text = this.content || '';
    const lines = text.split('\n');
    const idx = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));

    let start = 0;
    for (let i = 0; i < idx; i++) start += lines[i].length + 1;
    const end = start + lines[idx].length;
    return { start, end };
  }

  private applyInlineScopeTarget(): void {
    const text = this.content || '';

    if (!text.length) {
      const caret = Math.max(0, Math.min(this.inlineAi.anchorPos, text.length));
      this.inlineAi.selStart = caret;
      this.inlineAi.selEnd = caret;
      this.inlineAi.originalText = '';
      return;
    }

    if (this.inlineAi.scope === 'selection' && this.inlineAi.hasInitialSelection) {
      const s = Math.max(0, Math.min(this.inlineAi.initialSelStart, text.length));
      const e = Math.max(0, Math.min(this.inlineAi.initialSelEnd, text.length));
      this.inlineAi.selStart = Math.min(s, e);
      this.inlineAi.selEnd = Math.max(s, e);
      this.inlineAi.originalText = text.substring(this.inlineAi.selStart, this.inlineAi.selEnd);
      return;
    }

    if (this.inlineAi.scope === 'section') {
      const { start, end } = this.getSectionBoundsForPosition(this.inlineAi.anchorPos);
      this.inlineAi.selStart = start;
      this.inlineAi.selEnd = end;
      this.inlineAi.originalText = text.substring(start, end);
      return;
    }

    this.inlineAi.selStart = 0;
    this.inlineAi.selEnd = text.length;
    this.inlineAi.originalText = text;
  }

  private describeCurrentInlineScopeTarget(): string {
    if (this.inlineAi.scope === 'selection') return 'selected text';
    if (this.inlineAi.scope === 'section') return 'current section';
    return 'whole document';
  }

  private getSectionBoundsForPosition(position: number): { start: number; end: number } {
    const text = this.content || '';
    if (!text.length) return { start: 0, end: 0 };

    const lines = text.split('\n');
    const lineStarts: number[] = [];
    let pos = 0;
    for (const line of lines) {
      lineStarts.push(pos);
      pos += line.length + 1;
    }

    const clampedPos = Math.max(0, Math.min(position, text.length));
    let currentLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lineStarts[i] <= clampedPos) currentLine = i;
      else break;
    }

    const headingInfo = (line: string): { level: number } | null => {
      const m = line.match(/^\s{0,3}(#{1,6})\s+\S/);
      return m ? { level: m[1].length } : null;
    };

    let currentHeadingLine = -1;
    let currentHeadingLevel = 7;
    for (let i = currentLine; i >= 0; i--) {
      const info = headingInfo(lines[i]);
      if (info) {
        currentHeadingLine = i;
        currentHeadingLevel = info.level;
        break;
      }
    }

    if (currentHeadingLine === -1) {
      let firstHeading = -1;
      for (let i = 0; i < lines.length; i++) {
        if (headingInfo(lines[i])) {
          firstHeading = i;
          break;
        }
      }
      const end = firstHeading === -1 ? text.length : Math.max(0, lineStarts[firstHeading] - 1);
      return { start: 0, end };
    }

    let end = text.length;
    for (let i = currentHeadingLine + 1; i < lines.length; i++) {
      const info = headingInfo(lines[i]);
      if (info && info.level <= currentHeadingLevel) {
        end = Math.max(0, lineStarts[i] - 1);
        break;
      }
    }

    return { start: lineStarts[currentHeadingLine], end };
  }

  private getDocumentContextForAi(maxChars = 12000): string {
    const raw = this.content || '';
    const text = raw.length > maxChars
      ? raw.slice(0, maxChars) + '\n...[truncated]'
      : raw;

    const numbered = text
      .split('\n')
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n');

    return `Document snapshot (line-numbered):\n\`\`\`\n${numbered}\n\`\`\``;
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

    // Use the proportion of the match position within the total text to
    // derive the scroll target.  This handles line wrapping correctly
    // (the old lineNumber * lineHeight formula broke in split mode).
    const totalLines = (textarea.value.match(/\n/g) || []).length + 1;
    const lineNumber = (textarea.value.substring(0, result.start).match(/\n/g) || []).length;
    const lineRatio = lineNumber / Math.max(1, totalLines);
    const maxScroll = textarea.scrollHeight - textarea.clientHeight;
    const targetScrollTop = lineRatio * maxScroll - textarea.clientHeight / 3;

    textarea.scrollTo({
      top: Math.max(0, Math.min(maxScroll, targetScrollTop)),
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

    // Use percentage-based calculation against actual scrollHeight so that
    // line wrapping (white-space: pre-wrap) is handled correctly.  The old
    // `scrollTop / lineHeight` formula counted *visual* lines, not content
    // lines, which broke syntax highlighting in split mode where the narrower
    // pane causes heavy wrapping.
    const maxScroll = ta.scrollHeight - ta.clientHeight;
    if (maxScroll <= 0) return [0, totalLines - 1]; // all content fits

    const scrollRatio = ta.scrollTop / maxScroll;
    const viewRatio = ta.clientHeight / Math.max(1, ta.scrollHeight);
    const visibleCount = Math.ceil(viewRatio * totalLines);
    const firstVisible = Math.floor(scrollRatio * (totalLines - visibleCount));
    const lastVisible = firstVisible + visibleCount;

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
