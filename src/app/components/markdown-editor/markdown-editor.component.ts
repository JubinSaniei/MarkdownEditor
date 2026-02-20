import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit, OnDestroy, HostListener } from '@angular/core';

@Component({
  selector: 'app-markdown-editor',
  templateUrl: './markdown-editor.component.html',
  styleUrls: ['./markdown-editor.component.scss'],
  standalone: false
})
export class MarkdownEditorComponent implements AfterViewInit, OnDestroy {
  @Input() content: string = '';
  @Input() readOnly = false;
  @Output() contentChange = new EventEmitter<string>();
  @ViewChild('editor') editorElement!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('highlightBackdrop') highlightBackdrop!: ElementRef<HTMLDivElement>;
  @ViewChild('lineNumbers') lineNumbersEl!: ElementRef<HTMLDivElement>;
  @ViewChild('cheatsheetPanel') cheatsheetPanelEl!: ElementRef<HTMLDivElement>;
  @ViewChild('cheatsheetBtn') cheatsheetBtnEl!: ElementRef<HTMLButtonElement>;

  showCheatsheet = false;

  private resizeObserver: ResizeObserver | null = null;

  get lineNumberList(): number[] {
    const count = (this.content || '').split('\n').length;
    return Array.from({ length: count }, (_, i) => i + 1);
  }

  trackByNumber(_: number, n: number): number { return n; }

  ngAfterViewInit() {
    if (this.editorElement && this.highlightBackdrop) {
      this.editorElement.nativeElement.addEventListener('scroll', () => {
        this.syncScroll();
        if (this.lineNumbersEl) {
          this.lineNumbersEl.nativeElement.scrollTop = this.editorElement.nativeElement.scrollTop;
        }
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
    }
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
  }

  // ── Scroll / layout sync ─────────────────────────────────────

  /** Move the backdrop via CSS transform so it stays aligned with the textarea. */
  private syncScroll() {
    if (!this.editorElement || !this.highlightBackdrop) return;
    const ta = this.editorElement.nativeElement;
    this.highlightBackdrop.nativeElement.style.transform = `translateY(${-ta.scrollTop}px)`;
  }

  /** Set the backdrop width to the textarea's clientWidth (which excludes the scrollbar). */
  private syncBackdropWidth() {
    if (!this.editorElement || !this.highlightBackdrop) return;
    const ta = this.editorElement.nativeElement;
    this.highlightBackdrop.nativeElement.style.width = ta.clientWidth + 'px';
  }

  /** Copy computed text properties from the textarea to the backdrop. */
  private syncBackdropStyles() {
    if (!this.editorElement || !this.highlightBackdrop) return;
    const cs = window.getComputedStyle(this.editorElement.nativeElement);
    const bd = this.highlightBackdrop.nativeElement.style;
    bd.lineHeight = cs.lineHeight;
    bd.fontFamily = cs.fontFamily;
    bd.fontSize = cs.fontSize;
    bd.paddingTop = cs.paddingTop;
    bd.paddingRight = cs.paddingRight;
    bd.paddingBottom = cs.paddingBottom;
    bd.paddingLeft = cs.paddingLeft;
  }

  // ── Content ──────────────────────────────────────────────────

  onContentChange(event: any) {
    this.content = event.target.value;
    this.contentChange.emit(this.content);
  }

  onEditorKeyDown(event: KeyboardEvent) {
    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl) return;
    switch (event.key) {
      case 'b': event.preventDefault(); this.fmtBold();       return;
      case 'i': event.preventDefault(); this.fmtItalic();     return;
      case 'k': event.preventDefault(); this.fmtLink();       return;
      case '`': event.preventDefault(); this.fmtInlineCode(); return;
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
    if (!this.highlightBackdrop || !this.editorElement) return;

    const textarea = this.editorElement.nativeElement;
    const backdrop = this.highlightBackdrop.nativeElement;

    if (query && results.length > 0) {
      textarea.classList.add('search-active');
    } else {
      textarea.classList.remove('search-active');
    }

    if (!query || results.length === 0) {
      backdrop.innerHTML = '';
      return;
    }

    // Build highlighted HTML, escaping ALL content to prevent
    // raw < > & from breaking the backdrop layout.
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

    backdrop.innerHTML = html;

    // Sync width and position after the DOM update
    this.syncBackdropWidth();
    this.syncScroll();
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
    if (this.highlightBackdrop) {
      this.highlightBackdrop.nativeElement.innerHTML = '';
    }
    if (this.editorElement) {
      this.editorElement.nativeElement.classList.remove('search-active');
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
