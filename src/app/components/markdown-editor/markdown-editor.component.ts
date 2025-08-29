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
  @ViewChild('searchInput') searchInputElement!: ElementRef<HTMLInputElement>;
  @ViewChild('highlightBackdrop') highlightBackdrop!: ElementRef<HTMLDivElement>;

  showSearch: boolean = false;
  searchQuery: string = '';
  currentMatch: number = 0;
  totalMatches: number = 0;
  searchMatches: { start: number; end: number }[] = [];

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
    // Update search results if search is active
    if (this.showSearch && this.searchQuery) {
      this.performSearch();
    }
  }

  onEditorKeyDown(event: KeyboardEvent) {
    // Ctrl+F to open search
    if (event.ctrlKey && event.key === 'f') {
      event.preventDefault();
      this.openSearch();
    }
    // F3 for next, Shift+F3 for previous
    else if (event.key === 'F3') {
      event.preventDefault();
      if (event.shiftKey) {
        this.findPrevious();
      } else {
        this.findNext();
      }
    }
    // Escape to close search
    else if (event.key === 'Escape' && this.showSearch) {
      this.closeSearch();
    }
  }

  onSearchKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        this.findPrevious();
      } else {
        this.findNext();
      }
    } else if (event.key === 'F3') {
      event.preventDefault();
      if (event.shiftKey) {
        this.findPrevious();
      } else {
        this.findNext();
      }
    } else if (event.key === 'Escape') {
      this.closeSearch();
    }
  }

  onSearchQueryChange() {
    this.performSearch();
  }

  openSearch() {
    this.showSearch = true;
    setTimeout(() => {
      if (this.searchInputElement) {
        this.searchInputElement.nativeElement.focus();
        // If there's selected text, use it as search query
        const selection = this.getSelectedText();
        if (selection) {
          this.searchQuery = selection;
          this.performSearch(true);
        }
      }
    }, 100);
  }

  closeSearch() {
    this.showSearch = false;
    this.searchQuery = '';
    this.searchMatches = [];
    this.currentMatch = 0;
    this.totalMatches = 0;
    this.clearHighlights();
    // Focus back to editor
    if (this.editorElement) {
      this.editorElement.nativeElement.focus();
    }
  }

  performSearch(highlightFirst: boolean = false) {
    this.searchMatches = [];
    this.currentMatch = 0;
    this.totalMatches = 0;

    if (!this.searchQuery || !this.content) {
      this.clearHighlights();
      return;
    }

    const query = this.searchQuery.toLowerCase();
    const text = this.content.toLowerCase();
    let index = 0;

    while ((index = text.indexOf(query, index)) !== -1) {
      this.searchMatches.push({
        start: index,
        end: index + query.length
      });
      index += query.length;
    }

    this.totalMatches = this.searchMatches.length;
    if (this.totalMatches > 0) {
      this.currentMatch = 1;
      this.updateBackdropHighlights();
      // Only highlight and focus if explicitly requested (not during typing)
      if (highlightFirst) {
        this.highlightCurrentMatch();
      }
    } else {
      this.clearHighlights();
    }
  }

  findNext() {
    if (this.totalMatches === 0) return;
    
    this.currentMatch = this.currentMatch < this.totalMatches ? this.currentMatch + 1 : 1;
    this.updateBackdropHighlights();
    this.highlightCurrentMatch();
  }

  findPrevious() {
    if (this.totalMatches === 0) return;
    
    this.currentMatch = this.currentMatch > 1 ? this.currentMatch - 1 : this.totalMatches;
    this.updateBackdropHighlights();
    this.highlightCurrentMatch();
  }

  private highlightCurrentMatch() {
    if (this.currentMatch === 0 || !this.editorElement) return;

    const match = this.searchMatches[this.currentMatch - 1];
    const textarea = this.editorElement.nativeElement;
    
    // Set selection to the current match
    textarea.setSelectionRange(match.start, match.end);
    
    // Only focus if search is not currently active (prevents stealing focus from search input)
    const activeElement = document.activeElement as HTMLElement;
    const isSearchInputFocused = activeElement && activeElement.classList.contains('search-input');
    
    if (!isSearchInputFocused) {
      textarea.focus();
    }
    
    // Always scroll to the selection
    this.scrollToSelection();
  }

  private scrollToSelection() {
    if (!this.editorElement) return;
    
    const textarea = this.editorElement.nativeElement;
    const selectionStart = textarea.selectionStart;
    
    // Use browser's built-in scrollIntoView for more accurate scrolling
    setTimeout(() => {
      // Set selection again to ensure it's current
      textarea.setSelectionRange(selectionStart, textarea.selectionEnd);
      
      // Calculate line position more accurately
      const style = window.getComputedStyle(textarea);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      
      // Count lines to selection
      const textBeforeSelection = textarea.value.substring(0, selectionStart);
      const lineNumber = (textBeforeSelection.match(/\n/g) || []).length;
      
      // Calculate scroll position
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
    }, 10);
  }

  private getSelectedText(): string {
    if (!this.editorElement) return '';
    
    const textarea = this.editorElement.nativeElement;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    
    return textarea.value.substring(start, end);
  }

  private updateBackdropHighlights() {
    if (!this.highlightBackdrop || !this.editorElement) return;

    const textarea = this.editorElement.nativeElement;
    const backdrop = this.highlightBackdrop.nativeElement;
    
    // Add search-active class to textarea
    if (this.searchQuery && this.totalMatches > 0) {
      textarea.classList.add('search-active');
    } else {
      textarea.classList.remove('search-active');
    }

    if (!this.searchQuery || this.searchMatches.length === 0) {
      backdrop.innerHTML = '';
      return;
    }

    // Create highlighted text for backdrop
    let highlightedText = this.content;
    const query = this.searchQuery;
    
    // Sort matches by start position in descending order for proper replacement
    const sortedMatches = [...this.searchMatches].sort((a, b) => b.start - a.start);
    
    sortedMatches.forEach((match, index) => {
      const isCurrent = (sortedMatches.length - index) === this.currentMatch;
      const highlightClass = isCurrent ? 'search-highlight current' : 'search-highlight';
      const before = highlightedText.substring(0, match.start);
      const matchText = highlightedText.substring(match.start, match.end);
      const after = highlightedText.substring(match.end);
      
      highlightedText = before + `<span class="${highlightClass}">${this.escapeHtml(matchText)}</span>` + after;
    });

    backdrop.innerHTML = highlightedText;
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
