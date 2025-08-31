import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit } from '@angular/core';

@Component({
  selector: 'app-markdown-editor',
  templateUrl: './markdown-editor.component.html',
  styleUrls: ['./markdown-editor.component.scss'],
  standalone: false
})
export class MarkdownEditorComponent implements AfterViewInit {
  @Input() content: string = '';
  @Output() contentChange = new EventEmitter<string>();
  @ViewChild('editor') editorElement!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('highlightBackdrop') highlightBackdrop!: ElementRef<HTMLDivElement>;


  ngAfterViewInit() {
    // Set up scroll synchronization between textarea and backdrop
    if (this.editorElement && this.highlightBackdrop) {
      this.editorElement.nativeElement.addEventListener('scroll', () => {
        if (this.highlightBackdrop) {
          this.highlightBackdrop.nativeElement.scrollTop = this.editorElement.nativeElement.scrollTop;
          this.highlightBackdrop.nativeElement.scrollLeft = this.editorElement.nativeElement.scrollLeft;
        }
      });
    }
  }

  onContentChange(event: any) {
    this.content = event.target.value;
    this.contentChange.emit(this.content);
  }


  /**
   * Highlight search results in the editor
   */
  highlightSearchResults(query: string, results: any[], currentIndex: number) {
    if (!query || !results.length) {
      this.clearHighlights();
      return;
    }

    this.updateBackdropHighlights(query, results, currentIndex);
    
    // Scroll to current result if exists
    if (currentIndex > 0 && results[currentIndex - 1]) {
      this.scrollToResult(results[currentIndex - 1]);
    }
  }

  /**
   * Clean up search highlighting - called by parent component
   */
  closeSearch() {
    this.clearHighlights();
    // Focus back to editor
    if (this.editorElement) {
      this.editorElement.nativeElement.focus();
    }
  }

  private updateBackdropHighlights(query: string, results: any[], currentIndex: number) {
    if (!this.highlightBackdrop || !this.editorElement) return;

    const textarea = this.editorElement.nativeElement;
    const backdrop = this.highlightBackdrop.nativeElement;
    
    // Add search-active class to textarea
    if (query && results.length > 0) {
      textarea.classList.add('search-active');
    } else {
      textarea.classList.remove('search-active');
    }

    if (!query || results.length === 0) {
      backdrop.innerHTML = '';
      return;
    }

    // Create highlighted text for backdrop
    let highlightedText = this.content;
    
    // Sort matches by start position in descending order for proper replacement
    const sortedMatches = [...results].sort((a, b) => b.start - a.start);
    
    sortedMatches.forEach((match, index) => {
      const isCurrent = (sortedMatches.length - index) === currentIndex;
      const highlightClass = isCurrent ? 'search-highlight current' : 'search-highlight';
      const before = highlightedText.substring(0, match.start);
      const matchText = highlightedText.substring(match.start, match.end);
      const after = highlightedText.substring(match.end);
      
      highlightedText = before + `<span class="${highlightClass}">${this.escapeHtml(matchText)}</span>` + after;
    });

    backdrop.innerHTML = highlightedText;
  }

  private scrollToResult(result: any) {
    if (!this.editorElement) return;
    
    const textarea = this.editorElement.nativeElement;
    
    // Set selection to the current match
    textarea.setSelectionRange(result.start, result.end);
    
    // Calculate line position for scrolling
    const textBeforeSelection = textarea.value.substring(0, result.start);
    const lineNumber = (textBeforeSelection.match(/\n/g) || []).length;
    
    const style = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const targetScrollTop = lineNumber * lineHeight - textarea.clientHeight / 3;
    
    // Smooth scroll to position
    textarea.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth'
    });
    
    // Also sync the backdrop if it exists
    if (this.highlightBackdrop) {
      this.highlightBackdrop.nativeElement.scrollTop = textarea.scrollTop;
    }
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
