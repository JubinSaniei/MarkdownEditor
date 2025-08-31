export interface SearchResult {
  start: number;
  end: number;
  text: string;
  context?: string; // Optional surrounding context
}

export interface SearchState {
  query: string;
  isActive: boolean;
  results: SearchResult[];
  currentIndex: number;
  totalMatches: number;
  searchMode: SearchMode;
}

export enum SearchMode {
  EDITOR = 'editor',
  PREVIEW = 'preview', 
  SPLIT = 'split'
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}

export interface SearchTarget {
  type: 'editor' | 'preview';
  content: string;
  element?: HTMLElement;
}