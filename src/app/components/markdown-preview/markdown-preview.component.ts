import {
  Component, Input, OnChanges, OnDestroy,
  ViewChild, ElementRef, ViewEncapsulation, AfterViewChecked
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import hljs from 'highlight.js';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-markdown-preview',
  templateUrl: './markdown-preview.component.html',
  styleUrls: ['./markdown-preview.component.scss'],
  encapsulation: ViewEncapsulation.None,
  standalone: false
})
export class MarkdownPreviewComponent implements OnChanges, OnDestroy, AfterViewChecked {
  @Input() content: string = '';
  @ViewChild('previewContent') previewElement!: ElementRef<HTMLDivElement>;

  htmlContent: SafeHtml = '';
  originalHtmlContent: string = '';

  private needsListeners = false;

  // Event delegation handler bound to this instance
  private copyClickHandler = (event: Event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-code-id]');
    if (btn) {
      const codeId = btn.getAttribute('data-code-id');
      if (codeId) this.copyCodeToClipboard(codeId);
    }
  };

  private anchorClickHandler = (event: Event) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';

    if (href.startsWith('#')) {
      event.preventDefault();
      const target = this.previewElement?.nativeElement.querySelector(
        '#' + CSS.escape(href.slice(1))
      ) as HTMLElement | null;
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      event.preventDefault();
      this.electronService.openExternal(href);
    }
  };

  constructor(
    private sanitizer: DomSanitizer,
    private electronService: ElectronService
  ) {
    this.configureMarked();
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')   // strip punctuation except hyphens
      .trim()
      .replace(/\s+/g, '-');      // spaces → hyphens
  }

  private configureMarked() {
    marked.use({ gfm: true, breaks: true, pedantic: false });

    const renderer = new marked.Renderer();

    renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
      const id = this.slugify(text.replace(/<[^>]+>/g, '')); // strip any inner HTML tags before slugging
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    };

    renderer.code = ({ text, lang }: { text: string; lang?: string; escaped?: boolean }) => {
      const codeId = 'code-' + Math.random().toString(36).substr(2, 9);

      if (lang && hljs.getLanguage(lang)) {
        try {
          const highlighted = hljs.highlight(text, { language: lang }).value;
          return this.codeBlockHtml(codeId, lang, highlighted, false);
        } catch (_) {}
      }

      try {
        const result = hljs.highlightAuto(text);
        return this.codeBlockHtml(codeId, result.language || 'text', result.value, false);
      } catch (_) {
        return this.codeBlockHtml(codeId, 'text', this.escapeHtml(text), true);
      }
    };

    marked.use({ renderer });
  }

  private codeBlockHtml(codeId: string, lang: string, code: string, preEscaped: boolean): string {
    return `<div class="code-block-container">
      <div class="code-block-header">
        <span class="code-language">${lang}</span>
        <button class="copy-btn" data-code-id="${codeId}" title="Copy code">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor">
            <rect x="4" y="4" width="8" height="8" rx="1" opacity=".8"/>
            <path d="M2 9V2h7v1" opacity=".6"/>
          </svg>
        </button>
      </div>
      <pre class="hljs" id="${codeId}"><code class="language-${lang}">${code}</code></pre>
    </div>`;
  }

  ngOnChanges() {
    this.renderMarkdown();
    this.needsListeners = true;
  }

  ngAfterViewChecked() {
    if (this.needsListeners) {
      this.attachCopyListeners();
      this.needsListeners = false;
    }
  }

  ngOnDestroy() {
    const el = this.previewElement?.nativeElement;
    if (el) {
      el.removeEventListener('click', this.copyClickHandler);
      el.removeEventListener('click', this.anchorClickHandler);
    }
  }

  private attachCopyListeners() {
    const el = this.previewElement?.nativeElement;
    if (!el) return;
    el.removeEventListener('click', this.copyClickHandler);
    el.addEventListener('click', this.copyClickHandler);
    el.removeEventListener('click', this.anchorClickHandler);
    el.addEventListener('click', this.anchorClickHandler);
  }

  // ── Search Highlighting ──────────────────────────────────────

  highlightSearchResults(query: string, results: any[], currentIndex: number) {
    if (!query || !results.length) {
      this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(this.originalHtmlContent);
      return;
    }

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = this.originalHtmlContent;
    this.highlightMatches(tempDiv, query);
    this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(tempDiv.innerHTML);

    requestAnimationFrame(() => this.scrollToCurrentMatch(currentIndex));
  }

  scrollToTop() {
    if (this.previewElement) {
      this.previewElement.nativeElement.scrollTop = 0;
    }
  }

  /**
   * Clear highlights without stealing focus — used by parent when
   * search state changes (e.g. query becomes empty).
   */
  clearSearchHighlights() {
    this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(this.originalHtmlContent);
  }

  /**
   * Clear highlights and return focus — called when the user explicitly
   * closes the search panel (Esc / X button).
   */
  closeSearch() {
    this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(this.originalHtmlContent);
    this.previewElement?.nativeElement.focus();
  }

  private highlightMatches(element: HTMLElement, query: string) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node as Text);

    const lowerQuery = query.toLowerCase();
    textNodes.forEach(textNode => {
      const text = textNode.textContent || '';
      const lowerText = text.toLowerCase();
      if (!lowerText.includes(lowerQuery)) return;

      const parts: Node[] = [];
      let lastIndex = 0;
      let idx = 0;

      while ((idx = lowerText.indexOf(lowerQuery, idx)) !== -1) {
        if (idx > lastIndex) parts.push(document.createTextNode(text.substring(lastIndex, idx)));
        const mark = document.createElement('mark');
        mark.className = 'search-highlight';
        mark.textContent = text.substring(idx, idx + query.length);
        parts.push(mark);
        lastIndex = idx + query.length;
        idx = lastIndex;
      }
      if (lastIndex < text.length) parts.push(document.createTextNode(text.substring(lastIndex)));

      const parent = textNode.parentNode;
      if (parent) {
        parts.forEach(p => parent.insertBefore(p, textNode));
        parent.removeChild(textNode);
      }
    });
  }

  private scrollToCurrentMatch(currentIndex: number) {
    if (!this.previewElement) return;
    const highlights = this.previewElement.nativeElement.querySelectorAll('.search-highlight');
    highlights.forEach((h, i) => h.classList.toggle('current', i === currentIndex - 1));
    const current = this.previewElement.nativeElement.querySelector('.search-highlight.current');
    current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ── Clipboard ────────────────────────────────────────────────

  private copyCodeToClipboard(codeId: string): void {
    const el = document.getElementById(codeId);
    if (!el) return;
    const text = el.textContent || '';

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
        .then(() => this.showCopyFeedback(codeId))
        .catch(() => this.fallbackCopy(text, codeId));
    } else {
      this.fallbackCopy(text, codeId);
    }
  }

  private fallbackCopy(text: string, codeId: string): void {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); this.showCopyFeedback(codeId); } catch (_) {}
    document.body.removeChild(ta);
  }

  private showCopyFeedback(codeId: string): void {
    const container = document.getElementById(codeId)?.closest('.code-block-container');
    const btn = container?.querySelector('.copy-btn');
    if (!btn) return;
    const original = btn.innerHTML;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="#10b981" stroke-width="1.5" stroke-linecap="round"><path d="M2 7l3 3 6-6"/></svg>`;
    btn.setAttribute('title', 'Copied!');
    setTimeout(() => {
      btn.innerHTML = original;
      btn.setAttribute('title', 'Copy code');
    }, 2000);
  }

  // ── Render ───────────────────────────────────────────────────

  private renderMarkdown() {
    if (this.content) {
      let html = marked.parse(this.content) as string;
      html = this.postProcessHtml(html);
      this.originalHtmlContent = html;
    } else {
      this.originalHtmlContent = '<p class="empty-preview">Preview will appear here…</p>';
    }
    this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(this.originalHtmlContent);
  }

  private postProcessHtml(html: string): string {
    html = html.replace(/<blockquote>/g, '<blockquote class="markdown-blockquote">');
    html = html.replace(/<table>/g, '<div class="table-wrapper markdown-table"><table>');
    html = html.replace(/<\/table>/g, '</table></div>');
    html = html.replace(/<code(?![^>]*class="language-)>/g, '<code class="markdown-inline-code">');
    return html;
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return text.replace(/[&<>"']/g, m => map[m]);
  }
}
