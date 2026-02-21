import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { SearchState, SearchResult, SearchMode, SearchOptions, SearchTarget } from '../interfaces/search.interface';

@Injectable({
  providedIn: 'root'
})
export class SearchService implements OnDestroy {
  private debouncedSub: Subscription;
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

  public readonly searchState: Observable<SearchState> = this.searchState$.asObservable();

  public readonly debouncedSearch: Observable<string> = this.searchQuery$.pipe(
    debounceTime(300),
    distinctUntilChanged()
  );

  constructor() {
    this.debouncedSub = this.debouncedSearch.subscribe(query => {
      const currentState = this.getCurrentState();
      this.searchState$.next({ ...currentState, query });
    });
  }

  ngOnDestroy(): void {
    this.debouncedSub.unsubscribe();
  }

  getCurrentState(): SearchState {
    return this.searchState$.value;
  }

  openSearch(): void {
    this.searchState$.next({ ...this.getCurrentState(), isActive: true });
  }

  closeSearch(): void {
    this.searchState$.next({
      query: '',
      isActive: false,
      results: [],
      currentIndex: 0,
      totalMatches: 0,
      searchMode: this.getCurrentState().searchMode
    });
    this.searchQuery$.next('');
  }

  toggleSearch(): void {
    if (this.getCurrentState().isActive) {
      this.closeSearch();
    } else {
      this.openSearch();
    }
  }

  setSearchMode(mode: SearchMode): void {
    this.searchState$.next({ ...this.getCurrentState(), searchMode: mode });
  }

  updateSearchQuery(query: string): void {
    this.searchState$.next({ ...this.getCurrentState(), query, currentIndex: 0 });
    this.searchQuery$.next(query);
  }

  performSearch(targets: SearchTarget[]): void {
    const query = this.getCurrentState().query;
    if (!query || targets.length === 0) {
      this.clearResults();
      return;
    }

    const allResults: SearchResult[] = [];
    targets.forEach(target => allResults.push(...this.searchInContent(query, target.content)));

    const currentState = this.getCurrentState();
    this.searchState$.next({
      ...currentState,
      results: allResults,
      totalMatches: allResults.length,
      currentIndex: allResults.length > 0 ? 1 : 0
    });
  }

  navigateNext(): void {
    const s = this.getCurrentState();
    if (s.totalMatches === 0) return;
    const newIndex = s.currentIndex < s.totalMatches ? s.currentIndex + 1 : 1;
    this.searchState$.next({ ...s, currentIndex: newIndex });
  }

  navigatePrevious(): void {
    const s = this.getCurrentState();
    if (s.totalMatches === 0) return;
    const newIndex = s.currentIndex > 1 ? s.currentIndex - 1 : s.totalMatches;
    this.searchState$.next({ ...s, currentIndex: newIndex });
  }

  getCurrentResult(): SearchResult | null {
    const s = this.getCurrentState();
    if (s.currentIndex === 0 || s.results.length === 0) return null;
    return s.results[s.currentIndex - 1] || null;
  }

  updateSearchOptions(options: Partial<SearchOptions>): void {
    this.searchOptions = { ...this.searchOptions, ...options };
  }

  getSearchOptions(): SearchOptions {
    return { ...this.searchOptions };
  }

  // --- Replace helpers ---

  replaceOne(content: string, currentIndex: number, replacement: string): string {
    const results = this.getCurrentState().results;
    if (!results.length || currentIndex < 1 || currentIndex > results.length) return content;
    const result = results[currentIndex - 1];
    return content.substring(0, result.start) + replacement + content.substring(result.end);
  }

  replaceAll(content: string, replacement: string): string {
    const results = [...this.getCurrentState().results].sort((a, b) => b.start - a.start);
    let newContent = content;
    for (const result of results) {
      newContent = newContent.substring(0, result.start) + replacement + newContent.substring(result.end);
    }
    return newContent;
  }

  // --- Private helpers ---

  private clearResults(): void {
    this.searchState$.next({ ...this.getCurrentState(), results: [], totalMatches: 0, currentIndex: 0 });
  }

  private searchInContent(query: string, content: string): SearchResult[] {
    if (!query || !content) return [];

    const results: SearchResult[] = [];
    const searchText = this.searchOptions.caseSensitive ? content : content.toLowerCase();
    const searchQuery = this.searchOptions.caseSensitive ? query : query.toLowerCase();

    let regex: RegExp;
    try {
      if (this.searchOptions.useRegex) {
        regex = new RegExp(searchQuery, this.searchOptions.caseSensitive ? 'g' : 'gi');
      } else if (this.searchOptions.wholeWord) {
        regex = new RegExp(`\\b${this.escapeRegExp(searchQuery)}\\b`, this.searchOptions.caseSensitive ? 'g' : 'gi');
      } else {
        regex = new RegExp(this.escapeRegExp(searchQuery), this.searchOptions.caseSensitive ? 'g' : 'gi');
      }
    } catch (_) {
      return this.simpleSearch(searchQuery, searchText, content);
    }

    let match;
    while ((match = regex.exec(searchText)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      results.push({ start, end, text: content.substring(start, end), context: this.getContext(content, start, end) });
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
    return results;
  }

  private simpleSearch(query: string, searchText: string, originalContent: string): SearchResult[] {
    const results: SearchResult[] = [];
    let index = 0;
    while ((index = searchText.indexOf(query, index)) !== -1) {
      const end = index + query.length;
      results.push({ start: index, end, text: originalContent.substring(index, end), context: this.getContext(originalContent, index, end) });
      index += query.length;
    }
    return results;
  }

  private getContext(content: string, start: number, end: number): string {
    const len = 50;
    const before = content.substring(Math.max(0, start - len), start);
    const match = content.substring(start, end);
    const after = content.substring(end, Math.min(content.length, end + len));
    return `${before}${match}${after}`;
  }

  private escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
