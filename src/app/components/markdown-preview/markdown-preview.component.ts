import { Component, Input, OnChanges, ViewChild, ElementRef, ViewEncapsulation, OnDestroy } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import hljs from 'highlight.js';

@Component({
  selector: 'app-markdown-preview',
  templateUrl: './markdown-preview.component.html',
  styleUrls: ['./markdown-preview.component.scss'],
  encapsulation: ViewEncapsulation.None,
  standalone: false
})
export class MarkdownPreviewComponent implements OnChanges, OnDestroy {
  @Input() content: string = '';
  @ViewChild('previewContent') previewElement!: ElementRef<HTMLDivElement>;
  
  htmlContent: SafeHtml = '';
  originalHtmlContent: string = '';

  constructor(private sanitizer: DomSanitizer) {
    this.configureMarked();
    
    // Make copy function available globally for onclick handlers
    (window as any).copyCodeToClipboard = this.copyCodeToClipboard.bind(this);
  }

  private configureMarked() {
    // Configure marked for better markdown rendering (v16+ API)
    marked.use({
      gfm: true,
      breaks: true,
      pedantic: false
    });

    // Configure marked to use highlight.js for syntax highlighting
    const renderer = new marked.Renderer();
    
    // Override the code rendering function with correct signature
    renderer.code = ({ text, lang, escaped }: { text: string; lang?: string; escaped?: boolean }) => {
      const code = text;
      const language = lang;
      
      // Generate a unique ID for this code block
      const codeId = 'code-' + Math.random().toString(36).substr(2, 9);
      
      // If language is specified and highlight.js supports it
      if (language && hljs.getLanguage(language)) {
        try {
          const highlighted = hljs.highlight(code, { language }).value;
          return `<div class="code-block-container">
                    <div class="code-block-header">
                      <span class="code-language">${language}</span>
                      <button class="copy-btn" onclick="copyCodeToClipboard('${codeId}')" title="Copy code">📋</button>
                    </div>
                    <pre class="hljs" id="${codeId}"><code class="language-${language}">${highlighted}</code></pre>
                  </div>`;
        } catch (err) {
          console.warn('Syntax highlighting failed:', err);
        }
      }
      
      // Fallback: try to auto-detect language
      try {
        const highlighted = hljs.highlightAuto(code).value;
        const detectedLang = hljs.highlightAuto(code).language || 'text';
        return `<div class="code-block-container">
                  <div class="code-block-header">
                    <span class="code-language">${detectedLang}</span>
                    <button class="copy-btn" onclick="copyCodeToClipboard('${codeId}')" title="Copy code">📋</button>
                  </div>
                  <pre class="hljs" id="${codeId}"><code>${highlighted}</code></pre>
                </div>`;
      } catch (err) {
        // Final fallback: no highlighting
        return `<div class="code-block-container">
                  <div class="code-block-header">
                    <span class="code-language">text</span>
                    <button class="copy-btn" onclick="copyCodeToClipboard('${codeId}')" title="Copy code">📋</button>
                  </div>
                  <pre class="hljs" id="${codeId}"><code>${this.escapeHtml(code)}</code></pre>
                </div>`;
      }
    };

    // Apply the custom renderer
    marked.use({ renderer });
  }

  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  ngOnChanges() {
    this.renderMarkdown();
  }

  /**
   * Highlight search results in the preview
   */
  highlightSearchResults(query: string, results: any[], currentIndex: number) {
    if (!query || !results.length) {
      // Restore original content without highlights
      this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(this.originalHtmlContent);
      return;
    }

    // Create a temporary div to work with the DOM
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = this.originalHtmlContent;
    
    this.highlightMatches(tempDiv, query);
    this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(tempDiv.innerHTML);
    
    // Scroll to current result after DOM update
    requestAnimationFrame(() => {
      this.scrollToCurrentMatch(currentIndex);
    });
  }

  /**
   * Clean up search highlighting - called by parent component
   */
  closeSearch() {
    // Restore original content without highlights
    this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(this.originalHtmlContent);
    // Focus back to preview
    if (this.previewElement) {
      this.previewElement.nativeElement.focus();
    }
  }

  private highlightMatches(element: HTMLElement, query: string) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT
    );

    const textNodes: Text[] = [];
    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node as Text);
    }

    let matchIndex = 0;
    textNodes.forEach(textNode => {
      const text = textNode.textContent || '';
      const lowerText = text.toLowerCase();
      const lowerQuery = query.toLowerCase();
      
      if (lowerText.includes(lowerQuery)) {
        const parts = [];
        let lastIndex = 0;
        let index = 0;
        
        while ((index = lowerText.indexOf(lowerQuery, index)) !== -1) {
          // Add text before match
          if (index > lastIndex) {
            parts.push(document.createTextNode(text.substring(lastIndex, index)));
          }
          
          // Add highlighted match
          const matchElement = document.createElement('mark');
          matchElement.className = 'search-highlight';
          matchElement.textContent = text.substring(index, index + query.length);
          parts.push(matchElement);
          
          matchIndex++;
          lastIndex = index + query.length;
          index = lastIndex;
        }
        
        // Add remaining text
        if (lastIndex < text.length) {
          parts.push(document.createTextNode(text.substring(lastIndex)));
        }
        
        // Replace the text node with highlighted parts
        const parent = textNode.parentNode;
        if (parent) {
          parts.forEach(part => parent.insertBefore(part, textNode));
          parent.removeChild(textNode);
        }
      }
    });
  }

  private scrollToCurrentMatch(currentIndex: number) {
    if (!this.previewElement) return;
    
    const highlights = this.previewElement.nativeElement.querySelectorAll('.search-highlight');
    
    // Update current class
    highlights.forEach((highlight, index) => {
      highlight.classList.toggle('current', index === currentIndex - 1);
    });
    
    // Scroll to current match
    const currentHighlight = this.previewElement.nativeElement.querySelector('.search-highlight.current');
    if (currentHighlight) {
      currentHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }



  copyCodeToClipboard(codeId: string): void {
    const codeElement = document.getElementById(codeId);
    if (codeElement) {
      const codeText = codeElement.textContent || '';
      
      // Use the modern clipboard API if available
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(codeText).then(() => {
          this.showCopyFeedback(codeId);
        }).catch(err => {
          console.error('Failed to copy code:', err);
          this.fallbackCopyTextToClipboard(codeText, codeId);
        });
      } else {
        // Fallback for older browsers or non-HTTPS
        this.fallbackCopyTextToClipboard(codeText, codeId);
      }
    }
  }

  private fallbackCopyTextToClipboard(text: string, codeId: string): void {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
      document.execCommand('copy');
      this.showCopyFeedback(codeId);
    } catch (err) {
      console.error('Fallback: Could not copy text: ', err);
    }
    
    document.body.removeChild(textArea);
  }

  private showCopyFeedback(codeId: string): void {
    const copyBtn = document.querySelector(`#${codeId}`);
    const container = copyBtn?.closest('.code-block-container');
    const copyButton = container?.querySelector('.copy-btn');
    
    if (copyButton) {
      const originalText = copyButton.textContent;
      copyButton.textContent = '✅';
      copyButton.setAttribute('title', 'Copied!');
      
      setTimeout(() => {
        copyButton.textContent = originalText;
        copyButton.setAttribute('title', 'Copy code');
      }, 2000);
    }
  }

  ngOnDestroy(): void {
    // Clean up the global function
    if ((window as any).copyCodeToClipboard) {
      delete (window as any).copyCodeToClipboard;
    }
  }

  private renderMarkdown() {
    if (this.content) {
      // Use marked with configured options (v16+ doesn't accept options in parse())
      let html = marked.parse(this.content) as string;
      
      // Debug: Log the generated HTML
      console.log('Generated HTML:', html);
      
      // Post-process the HTML for better formatting
      html = this.postProcessHtml(html);
      
      console.log('Post-processed HTML:', html);
      
      this.originalHtmlContent = html;
      this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(this.originalHtmlContent);
    } else {
      this.originalHtmlContent = '<p class="empty-preview">Preview will appear here...</p>';
      this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(this.originalHtmlContent);
    }
    
  }

  private postProcessHtml(html: string): string {
    // Add classes to blockquotes
    html = html.replace(/<blockquote>/g, '<blockquote class="markdown-blockquote">');
    
    // Wrap tables in responsive wrapper
    html = html.replace(/<table>/g, '<div class="table-wrapper markdown-table"><table>');
    html = html.replace(/<\/table>/g, '</table></div>');
    
    // Add classes to inline code (but not code blocks, which are handled by highlight.js)
    html = html.replace(/<code(?![^>]*class="language-)>/g, '<code class="markdown-inline-code">');
    
    return html;
  }
}
