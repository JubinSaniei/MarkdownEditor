import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit, OnChanges, OnDestroy, HostListener, SimpleChanges, NgZone } from '@angular/core';
import { Subscription } from 'rxjs';
import { AiService } from '../../services/ai.service';
import { AiSettingsService } from '../../services/ai-settings.service';
import { EditorView, keymap, lineNumbers as cmLineNumbers, drawSelection, highlightActiveLine, ViewUpdate } from '@codemirror/view';
import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { search, SearchQuery, setSearchQuery } from '@codemirror/search';
import { SearchOptions } from '../../interfaces/search.interface';

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
  @ViewChild('cmHost') cmHost!: ElementRef<HTMLDivElement>;
  @ViewChild('cheatsheetPanel') cheatsheetPanelEl!: ElementRef<HTMLDivElement>;
  @ViewChild('cheatsheetBtn') cheatsheetBtnEl!: ElementRef<HTMLButtonElement>;
  @ViewChild('inlineAiInput') inlineAiInputRef?: ElementRef<HTMLInputElement>;

  private editorView: EditorView | null = null;
  private readOnlyCompartment = new Compartment();
  private spellcheckCompartment = new Compartment();
  private internalUpdate = false;

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
  diffIgnoreWhitespace = false;
  inlineDiffRows: InlineDiffRow[] = [];
  inlineDiffHunks: InlineDiffHunk[] = [];
  inlineDiffDecisions: DiffDecision[] = [];
  inlineDiffOps: InlineDiffOp[] = [];
  activeDiffHunkIndex = 0;
  diffAddedLines = 0;
  diffRemovedLines = 0;

  private inlineAiSub?: Subscription;

  private static readonly editorTheme = EditorView.theme({
    '&': { fontSize: 'var(--editor-font-size)', fontFamily: 'var(--font-mono)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
      lineHeight: 'var(--editor-line-height)',
      caretColor: 'var(--text-primary)',
      padding: '16px 0',
      fontFamily: 'var(--font-mono)',
    },
    '.cm-line': { padding: '0 16px' },
    '.cm-gutters': {
      background: 'var(--bg-secondary, var(--bg-primary))',
      color: 'var(--text-tertiary)',
      border: 'none',
      paddingLeft: '8px',
    },
    '.cm-gutter.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 0',
      minWidth: '32px',
      fontSize: '12px',
      fontFamily: 'var(--font-mono)',
    },
    '.cm-activeLine': { background: 'var(--hover-bg)' },
    '.cm-activeLineGutter': { background: 'var(--hover-bg)' },
    '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      background: 'rgba(100, 148, 237, 0.35) !important',
    },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' },
  });

  private static readonly markdownHighlightStyle = syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.heading1, color: 'var(--syn-heading)', fontWeight: 'bold', fontSize: '1.4em' },
      { tag: tags.heading2, color: 'var(--syn-heading)', fontWeight: 'bold', fontSize: '1.25em' },
      { tag: tags.heading3, color: 'var(--syn-heading)', fontWeight: 'bold', fontSize: '1.1em' },
      { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--syn-heading)', fontWeight: 'bold' },
      { tag: tags.quote, color: 'var(--syn-quote)', fontStyle: 'italic' },
      { tag: tags.link, color: 'var(--syn-link)', textDecoration: 'underline' },
      { tag: tags.url, color: 'var(--syn-url)' },
      { tag: [tags.monospace, tags.character], color: 'var(--syn-code)', background: 'rgba(127,127,127,0.1)', borderRadius: '2px' },
      { tag: tags.emphasis, fontStyle: 'italic' },
      { tag: tags.strong, fontWeight: 'bold' },
      { tag: tags.strikethrough, textDecoration: 'line-through' },
      { tag: [tags.processingInstruction, tags.punctuation], color: 'var(--syn-punct)' },
      { tag: tags.content, color: 'var(--text-primary)' },
    ])
  );

  constructor(
    private aiService: AiService,
    private aiSettingsService: AiSettingsService,
    private ngZone: NgZone
  ) {}

  ngAfterViewInit() {
    // Initialize CodeMirror 6
    if (this.cmHost) {
      this.editorView = new EditorView({
        state: EditorState.create({
          doc: this.content,
          extensions: [
            cmLineNumbers(),
            history(),
            drawSelection(),
            highlightActiveLine(),
            search({ top: true }),
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            MarkdownEditorComponent.markdownHighlightStyle,
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              { key: 'Mod-b', run: () => { this.fmtBold(); return true; } },
              { key: 'Mod-i', run: () => { this.fmtItalic(); return true; } },
              { key: 'Mod-k', run: () => { this.fmtLink(); return true; } },
              { key: 'Mod-`', run: () => { this.fmtInlineCode(); return true; } },
              { key: 'Mod-Shift-a', run: () => { if (!this.readOnly) this.triggerInlineAi(); return true; } },
              { key: 'Escape', run: () => { if (this.inlineAi.visible) { this.discardInline(); return true; } return false; } },
            ]),
            this.readOnlyCompartment.of(EditorState.readOnly.of(this.readOnly || this.inlineAi.visible)),
            this.spellcheckCompartment.of(
              EditorView.contentAttributes.of({ spellcheck: this.spellcheckEnabled ? 'true' : 'false' })
            ),
            EditorView.updateListener.of((update: ViewUpdate) => {
              if (update.docChanged && !this.internalUpdate) {
                this.ngZone.run(() => {
                  this.internalUpdate = true;
                  this.content = update.state.doc.toString();
                  this.contentChange.emit(this.content);
                  this.internalUpdate = false;
                });
              }
            }),
            MarkdownEditorComponent.editorTheme,
            EditorView.lineWrapping,
          ]
        }),
        parent: this.cmHost.nativeElement
      });
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['content'] && this.editorView && !this.internalUpdate) {
      const current = this.editorView.state.doc.toString();
      if (this.content !== current) {
        this.internalUpdate = true;
        this.editorView.dispatch({
          changes: { from: 0, to: current.length, insert: this.content }
        });
        this.internalUpdate = false;
      }
    }
    if (changes['readOnly'] && this.editorView) {
      this.setEditorReadOnly(this.readOnly || this.inlineAi.visible);
    }

    if (changes['content']) {
      if (
        !changes['content'].firstChange &&
        changes['content'].previousValue !== changes['content'].currentValue &&
        this.inlineAi.visible
      ) {
        this.discardInline();
      }
    }
  }

  ngOnDestroy() {
    this.editorView?.destroy();
    this.inlineAiSub?.unsubscribe();
  }

  // ── CM6 Compatibility Bridge ─────────────────────────────
  /** Lock or unlock the editor by reconfiguring the readonly compartment. */
  private setEditorReadOnly(readOnly: boolean): void {
    this.editorView?.dispatch({
      effects: this.readOnlyCompartment.reconfigure(
        EditorState.readOnly.of(readOnly)
      )
    });
  }

  private getCmSelection(): { from: number; to: number } {
    if (!this.editorView) return { from: 0, to: 0 };
    const { from, to } = this.editorView.state.selection.main;
    return { from, to };
  }

  /** Apply a single precise range replacement via CM6, and set the resulting selection. */
  private cmDispatchChange(from: number, to: number, insert: string, selAnchor: number, selHead?: number): void {
    if (!this.editorView) return;
    this.editorView.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.range(selAnchor, selHead ?? selAnchor)
    });
  }

  /** Apply multiple precise range replacements in one transaction (for multi-line operations). */
  private cmDispatchChanges(changes: { from: number; to: number; insert: string }[], selAnchor: number, selHead?: number): void {
    if (!this.editorView) return;
    this.editorView.dispatch({
      changes,
      selection: EditorSelection.range(selAnchor, selHead ?? selAnchor)
    });
  }

  // ── Formatting helpers ───────────────────────────────────────

  /**
   * Wrap the current selection with `before` and `after` markers.
   * If the selection is already wrapped, remove the markers (toggle).
   * If nothing is selected, insert empty markers with cursor placed inside.
   */
  private wrapSelection(before: string, after: string) {
    if (!this.editorView) return;
    const { from: s, to: e } = this.getCmSelection();
    const v = this.content;
    const sel = v.substring(s, e);
    const bLen = before.length;
    const aLen = after.length;

    // Already wrapped — markers sit immediately outside the selection
    if (s >= bLen && v.substring(s - bLen, s) === before && v.substring(e, e + aLen) === after) {
      this.cmDispatchChanges([
        { from: s - bLen, to: s, insert: '' },
        { from: e, to: e + aLen, insert: '' }
      ], s - bLen, e - bLen);
      return;
    }

    if (sel) {
      this.cmDispatchChanges([
        { from: s, to: e, insert: before + sel + after }
      ], s + bLen, s + bLen + sel.length);
    } else {
      this.cmDispatchChanges([
        { from: s, to: s, insert: before + after }
      ], s + bLen);
    }
  }

  /**
   * Add or remove a fixed prefix on every line touched by the selection.
   * Removes if all covered lines already start with the prefix; adds otherwise.
   */
  private toggleLinePrefix(prefix: string) {
    if (!this.editorView) return;
    const { from: s, to: e } = this.getCmSelection();
    const v = this.content;

    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    // If selection ends exactly at the start of a new line, exclude that line
    const adjustedEnd = e > s && v[e - 1] === '\n' ? e - 1 : e;
    const lineEnd = (() => { const i = v.indexOf('\n', adjustedEnd); return i === -1 ? v.length : i; })();

    const chunk = v.substring(lineStart, lineEnd);
    const lines = chunk.split('\n');
    const allHave = lines.every(l => l.startsWith(prefix));

    // Build per-line changes, tracking each line's absolute start offset.
    const lineOffsets: number[] = [];
    { let pos = lineStart; for (const l of lines) { lineOffsets.push(pos); pos += l.length + 1; } }

    if (allHave) {
      const changes = lines.map((l, i) => ({ from: lineOffsets[i], to: lineOffsets[i] + prefix.length, insert: '' }));
      const newChunk = lines.map(l => l.substring(prefix.length)).join('\n');
      const removed = chunk.length - newChunk.length;
      this.cmDispatchChanges(changes, Math.max(lineStart, s - prefix.length), Math.max(lineStart, e - removed));
    } else {
      const changes = lines
        .map((l, i) => l.startsWith(prefix) ? null : { from: lineOffsets[i], to: lineOffsets[i], insert: prefix })
        .filter((c): c is { from: number; to: number; insert: string } => c !== null);
      const newChunk = lines.map(l => l.startsWith(prefix) ? l : prefix + l).join('\n');
      const added = newChunk.length - chunk.length;
      const firstLineGain = lines[0].startsWith(prefix) ? 0 : prefix.length;
      this.cmDispatchChanges(changes, s + firstLineGain, e + added);
    }
  }

  /** Numbered-list variant of toggleLinePrefix (handles variable-width numbers). */
  private toggleOrderedList() {
    if (!this.editorView) return;
    const { from: s, to: e } = this.getCmSelection();
    const v = this.content;

    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const adjustedEnd = e > s && v[e - 1] === '\n' ? e - 1 : e;
    const lineEnd = (() => { const i = v.indexOf('\n', adjustedEnd); return i === -1 ? v.length : i; })();

    const chunk = v.substring(lineStart, lineEnd);
    const lines = chunk.split('\n');
    const allOrdered = lines.every(l => /^\d+\.\s/.test(l));

    const lineOffsets: number[] = [];
    { let pos = lineStart; for (const l of lines) { lineOffsets.push(pos); pos += l.length + 1; } }

    if (allOrdered) {
      const changes = lines.map((l, i) => {
        const pfxLen = (l.match(/^\d+\.\s/) || [''])[0].length;
        return { from: lineOffsets[i], to: lineOffsets[i] + pfxLen, insert: '' };
      });
      const newChunk = lines.map(l => l.replace(/^\d+\.\s/, '')).join('\n');
      const removed = chunk.length - newChunk.length;
      const firstPfxLen = (lines[0].match(/^\d+\.\s/) || [''])[0].length;
      this.cmDispatchChanges(changes, Math.max(lineStart, s - firstPfxLen), Math.max(lineStart, e - removed));
    } else {
      const changes = lines
        .map((l, i) => /^\d+\.\s/.test(l) ? null : { from: lineOffsets[i], to: lineOffsets[i], insert: `${i + 1}. ` })
        .filter((c): c is { from: number; to: number; insert: string } => c !== null);
      const newChunk = lines.map((l, i) => /^\d+\.\s/.test(l) ? l : `${i + 1}. ${l}`).join('\n');
      const added = newChunk.length - chunk.length;
      const firstLineGain = /^\d+\.\s/.test(lines[0]) ? 0 : `${1}. `.length;
      this.cmDispatchChanges(changes, s + firstLineGain, e + added);
    }
  }

  // ── Public formatting actions ────────────────────────────────

  fmtBold()       { this.wrapSelection('**', '**'); }
  fmtItalic()     { this.wrapSelection('*', '*'); }
  fmtStrike()     { this.wrapSelection('~~', '~~'); }
  fmtInlineCode() { this.wrapSelection('`', '`'); }

  fmtHeading(level: number) {
    if (!this.editorView) return;
    const prefix = '#'.repeat(level) + ' ';
    const { from: s } = this.getCmSelection();
    const v = this.content;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const rawEnd = v.indexOf('\n', s);
    const lineEnd = rawEnd === -1 ? v.length : rawEnd;
    const line = v.substring(lineStart, lineEnd);
    const m = line.match(/^(#{1,6}) /);

    if (m) {
      if (m[1] === '#'.repeat(level)) {
        // Same level → remove heading
        const nc = Math.max(lineStart, s - m[0].length);
        this.cmDispatchChange(lineStart, lineStart + m[0].length, '', nc);
      } else {
        // Different level → replace
        const nc = s + (prefix.length - m[0].length);
        this.cmDispatchChange(lineStart, lineStart + m[0].length, prefix, nc);
      }
    } else {
      const nc = s + prefix.length;
      this.cmDispatchChange(lineStart, lineStart, prefix, nc);
    }
  }

  fmtBlockquote()    { this.toggleLinePrefix('> '); }
  fmtUnorderedList() { this.toggleLinePrefix('- '); }
  fmtOrderedList()   { this.toggleOrderedList(); }
  fmtTaskList()      { this.toggleLinePrefix('- [ ] '); }

  fmtCodeBlock() {
    if (!this.editorView) return;
    const { from: s, to: e } = this.getCmSelection();
    const v = this.content;
    const sel = v.substring(s, e);
    const insert = '```\n' + (sel || '') + '\n```';
    // Place cursor right after the opening ``` so the language can be typed
    this.cmDispatchChange(s, e, insert, s + 3);
  }

  fmtHR() {
    if (!this.editorView) return;
    const { from: s } = this.getCmSelection();
    const v = this.content;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const pre = lineStart > 0 ? '\n---\n\n' : '---\n\n';
    const nc = lineStart + pre.length;
    this.cmDispatchChange(lineStart, lineStart, pre, nc);
  }

  fmtLink() {
    if (!this.editorView) return;
    const { from: s, to: e } = this.getCmSelection();
    const v = this.content;
    const text = v.substring(s, e) || 'link text';
    const insert = `[${text}](url)`;
    const urlStart = s + 1 + text.length + 2; // after [text](
    this.cmDispatchChange(s, e, insert, urlStart, urlStart + 3); // select "url"
  }

  fmtImage() {
    if (!this.editorView) return;
    const { from: s, to: e } = this.getCmSelection();
    const v = this.content;
    const alt = v.substring(s, e) || 'alt text';
    const insert = `![${alt}](url)`;
    const urlStart = s + 2 + alt.length + 2; // after ![alt](
    this.cmDispatchChange(s, e, insert, urlStart, urlStart + 3); // select "url"
  }

  fmtTable() {
    if (!this.editorView) return;
    const { from: s } = this.getCmSelection();
    const v = this.content;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const pre = s > lineStart ? '\n' : '';
    const table =
      '| Header 1 | Header 2 | Header 3 |\n' +
      '| --- | --- | --- |\n' +
      '| Cell | Cell | Cell |\n' +
      '| Cell | Cell | Cell |';
    const insert = pre + table + '\n';
    // Select "Header 1" so the user can start typing immediately
    const h1Start = s + pre.length + 2;
    this.cmDispatchChange(s, s, insert, h1Start, h1Start + 8);
  }

  // ── Inline AI ─────────────────────────────────────────────────

  triggerInlineAi(): void {
    if (!this.editorView) return;
    this.inlineAiSub?.unsubscribe();
    this.inlineAiSub = undefined;
    const { from: rawSelStart, to: rawSelEnd } = this.getCmSelection();
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
    this.setEditorReadOnly(true);
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
    this.cmDispatchChange(selStart, selEnd, text, selStart + text.length);
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
    this.setEditorReadOnly(this.readOnly);
    setTimeout(() => this.editorView?.focus(), 0);
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
    this.cmDispatchChange(selStart, selEnd, text, selStart + text.length);
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

  highlightSearchResults(
    query: string,
    results: { start: number; end: number }[],
    currentIndex: number,
    searchOptions?: SearchOptions
  ): void {
    if (!this.editorView || !query) {
      this.clearSearchHighlights();
      return;
    }

    const cmQuery = new SearchQuery({
      search: query,
      caseSensitive: searchOptions?.caseSensitive ?? false,
      regexp: searchOptions?.useRegex ?? false,
      wholeWord: searchOptions?.wholeWord ?? false,
      // Disable CM6's default \n/\r/\t escape-sequence expansion for plain-text
      // queries so matching stays identical to SearchService's literal matching.
      literal: true,
    });

    this.editorView.dispatch({
      effects: setSearchQuery.of(cmQuery)
    });

    // Move the CM6 selection to the current match so CM6's own "selected match"
    // decoration highlights it distinctly, and scroll it into view.
    const current = results[currentIndex - 1];
    if (current) {
      const docLength = this.editorView.state.doc.length;
      const from = Math.max(0, Math.min(current.start, docLength));
      const to = Math.max(from, Math.min(current.end, docLength));
      this.editorView.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      });
    }
  }

  clearSearchHighlights(): void {
    if (!this.editorView) return;
    this.editorView.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: '' }))
    });
  }

  closeSearch(): void {
    this.clearSearchHighlights();
    this.editorView?.focus();
  }

  scrollToTop() {
    if (this.editorView) {
      this.editorView.dispatch({
        selection: EditorSelection.cursor(0),
        effects: EditorView.scrollIntoView(0, { y: 'start' })
      });
    }
  }

  /** Current vertical scroll position as a 0-1 fraction of the scrollable range. */
  getScrollFraction(): number | null {
    if (!this.editorView) return null;
    const el = this.editorView.scrollDOM;
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    return el.scrollTop / max;
  }

  /** Restore vertical scroll position from a 0-1 fraction. */
  setScrollFraction(frac: number): void {
    if (!this.editorView) return;
    const el = this.editorView.scrollDOM;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = frac * max;
  }

  refreshBackdropStyles() {
    this.editorView?.requestMeasure();
  }

  // ── Cheat Sheet ──────────────────────────────────────────────

  toggleCheatsheet() {
    this.showCheatsheet = !this.showCheatsheet;
  }

  toggleSpellcheck() {
    this.spellcheckEnabled = !this.spellcheckEnabled;
    this.editorView?.dispatch({
      effects: this.spellcheckCompartment.reconfigure(
        EditorView.contentAttributes.of({ spellcheck: this.spellcheckEnabled ? 'true' : 'false' })
      )
    });
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

  // ── Private helpers ─────────────────────────────────────────

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
