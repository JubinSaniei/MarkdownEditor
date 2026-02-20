import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';

@Component({
  selector: 'app-markdown-editor',
  templateUrl: './markdown-editor.component.html',
  styleUrls: ['./markdown-editor.component.scss'],
  standalone: false
})
export class MarkdownEditorComponent implements AfterViewInit, OnDestroy {
  @Input() content: string = '';
  @Output() contentChange = new EventEmitter<string>();
  @ViewChild('editor') editorElement!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('highlightBackdrop') highlightBackdrop!: ElementRef<HTMLDivElement>;
  @ViewChild('lineNumbers') lineNumbersEl!: ElementRef<HTMLDivElement>;

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
