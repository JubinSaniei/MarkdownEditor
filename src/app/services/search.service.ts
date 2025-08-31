import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { SearchState, SearchResult, SearchMode, SearchOptions, SearchTarget } from '../interfaces/search.interface';

@Injectable({
  providedIn: 'root'
})
export class SearchService {
  private searchState$ = new BehaviorSubject<SearchState>({
    query: '',
    isActive: false,
    results: [],
    currentIndex: 0,
    totalMatches: 0,
    searchMode: SearchMode.EDITOR
  });

  private searchQuery$ = new Subject<string>();
  private searchOptions: SearchOptions = {
    caseSensitive: false,
    wholeWord: false,
    useRegex: false
  };

  // Public observables
  public readonly searchState: Observable<SearchState> = this.searchState$.asObservable();
  
  // Debounced search query stream
  public readonly debouncedSearch: Observable<string> = this.searchQuery$.pipe(
    debounceTime(300),
    distinctUntilChanged()
  );

  constructor() {
    // Subscribe to debounced search to update query only
    this.debouncedSearch.subscribe(query => {
      // Just update the query in state, don't perform search here
      const currentState = this.getCurrentState();
      this.searchState$.next({
        ...currentState,
        query: query
      });
    });
  }

  /**
   * Get current search state
   */
  getCurrentState(): SearchState {
    return this.searchState$.value;
  }

  /**
   * Open search and focus input
   */
  openSearch(): void {
    const currentState = this.getCurrentState();
    this.searchState$.next({
      ...currentState,
      isActive: true
    });
  }

  /**
   * Close search and clear all results
   */
  closeSearch(): void {
    this.searchState$.next({
      query: '',
      isActive: false,
      results: [],
      currentIndex: 0,
      totalMatches: 0,
      searchMode: this.getCurrentState().searchMode
    });
    
    // Clear query stream
    this.searchQuery$.next('');
  }

  /**
   * Toggle search visibility
   */
  toggleSearch(): void {
    if (this.getCurrentState().isActive) {
      this.closeSearch();
    } else {
      this.openSearch();
    }
  }

  /**
   * Set search mode (editor, preview, or split)
   */
  setSearchMode(mode: SearchMode): void {
    const currentState = this.getCurrentState();
    this.searchState$.next({
      ...currentState,
      searchMode: mode
    });
  }

  /**
   * Update search query (triggers debounced search)
   */
  updateSearchQuery(query: string): void {
    const currentState = this.getCurrentState();
    
    // Update state immediately for UI responsiveness
    this.searchState$.next({
      ...currentState,
      query: query,
      currentIndex: 0
    });

    // Trigger debounced search
    this.searchQuery$.next(query);
  }

  /**
   * Perform search across specified targets
   */
  performSearch(targets: SearchTarget[]): void {
    const query = this.getCurrentState().query;
    if (!query || targets.length === 0) {
      this.clearResults();
      return;
    }

    const allResults: SearchResult[] = [];

    targets.forEach(target => {
      const results = this.searchInContent(query, target.content);
      allResults.push(...results);
    });

    const currentState = this.getCurrentState();
    this.searchState$.next({
      ...currentState,
      results: allResults,
      totalMatches: allResults.length,
      currentIndex: allResults.length > 0 ? 1 : 0
    });
  }

  /**
   * Navigate to next search result
   */
  navigateNext(): void {
    const currentState = this.getCurrentState();
    if (currentState.totalMatches === 0) return;

    const newIndex = currentState.currentIndex < currentState.totalMatches 
      ? currentState.currentIndex + 1 
      : 1;

    this.searchState$.next({
      ...currentState,
      currentIndex: newIndex
    });
  }

  /**
   * Navigate to previous search result
   */
  navigatePrevious(): void {
    const currentState = this.getCurrentState();
    if (currentState.totalMatches === 0) return;

    const newIndex = currentState.currentIndex > 1 
      ? currentState.currentIndex - 1 
      : currentState.totalMatches;

    this.searchState$.next({
      ...currentState,
      currentIndex: newIndex
    });
  }

  /**
   * Get current search result
   */
  getCurrentResult(): SearchResult | null {
    const state = this.getCurrentState();
    if (state.currentIndex === 0 || state.results.length === 0) {
      return null;
    }
    return state.results[state.currentIndex - 1] || null;
  }

  /**
   * Update search options
   */
  updateSearchOptions(options: Partial<SearchOptions>): void {
    this.searchOptions = { ...this.searchOptions, ...options };
    // Note: Components will re-search when they detect option changes
  }

  /**
   * Get current search options
   */
  getSearchOptions(): SearchOptions {
    return { ...this.searchOptions };
  }

  /**
   * Clear search results
   */
  private clearResults(): void {
    const currentState = this.getCurrentState();
    this.searchState$.next({
      ...currentState,
      results: [],
      totalMatches: 0,
      currentIndex: 0
    });
  }


  /**
   * Search within text content and return results
   */
  private searchInContent(query: string, content: string): SearchResult[] {
    if (!query || !content) return [];

    const results: SearchResult[] = [];
    const searchText = this.searchOptions.caseSensitive ? content : content.toLowerCase();
    const searchQuery = this.searchOptions.caseSensitive ? query : query.toLowerCase();

    let regex: RegExp;

    try {
      if (this.searchOptions.useRegex) {
        const flags = this.searchOptions.caseSensitive ? 'g' : 'gi';
        regex = new RegExp(searchQuery, flags);
      } else if (this.searchOptions.wholeWord) {
        const escapedQuery = this.escapeRegExp(searchQuery);
        const flags = this.searchOptions.caseSensitive ? 'g' : 'gi';
        regex = new RegExp(`\\b${escapedQuery}\\b`, flags);
      } else {
        const escapedQuery = this.escapeRegExp(searchQuery);
        const flags = this.searchOptions.caseSensitive ? 'g' : 'gi';
        regex = new RegExp(escapedQuery, flags);
      }
    } catch (e) {
      // Invalid regex, fall back to simple search
      return this.simpleSearch(searchQuery, searchText, content);
    }

    let match;
    while ((match = regex.exec(searchText)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      
      results.push({
        start,
        end,
        text: content.substring(start, end),
        context: this.getContext(content, start, end)
      });

      // Prevent infinite loop on zero-width matches
      if (match.index === regex.lastIndex) {
        regex.lastIndex++;
      }
    }

    return results;
  }

  /**
   * Simple search fallback for when regex fails
   */
  private simpleSearch(query: string, searchText: string, originalContent: string): SearchResult[] {
    const results: SearchResult[] = [];
    let index = 0;

    while ((index = searchText.indexOf(query, index)) !== -1) {
      const start = index;
      const end = index + query.length;
      
      results.push({
        start,
        end,
        text: originalContent.substring(start, end),
        context: this.getContext(originalContent, start, end)
      });

      index += query.length;
    }

    return results;
  }

  /**
   * Get surrounding context for a search result
   */
  private getContext(content: string, start: number, end: number): string {
    const contextLength = 50;
    const beforeStart = Math.max(0, start - contextLength);
    const afterEnd = Math.min(content.length, end + contextLength);
    
    const before = content.substring(beforeStart, start);
    const match = content.substring(start, end);
    const after = content.substring(end, afterEnd);
    
    return `${before}${match}${after}`;
  }

  /**
   * Escape special regex characters
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}