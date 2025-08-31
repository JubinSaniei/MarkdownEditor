import { Injectable, ElementRef } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class ScrollSyncService {
  private isSyncing: boolean = false; // Prevent infinite loops
  private editorElement: HTMLElement | null = null;
  private previewElement: HTMLElement | null = null;
  private editorScrollListener: (() => void) | null = null;
  private previewScrollListener: (() => void) | null = null;

  /**
   * CRITICAL: Setup bidirectional scroll synchronization
   * Both editor and preview must scroll together perfectly
   */
  setupSync(editorRef: ElementRef, previewRef: ElementRef): void {
    this.cleanup(); // Clean up any existing listeners
    
    // Get the actual scrollable elements
    this.editorElement = editorRef.nativeElement.querySelector('textarea');
    this.previewElement = previewRef.nativeElement.querySelector('.preview-content');
    
    if (!this.editorElement || !this.previewElement) {
      console.error('ScrollSyncService: Could not find scrollable elements');
      console.log('Editor element:', this.editorElement);
      console.log('Preview element:', this.previewElement);
      return;
    }

    console.log('ScrollSyncService: Setting up bidirectional sync');

    // Setup bidirectional listeners
    this.editorScrollListener = () => this.syncFromEditor();
    this.previewScrollListener = () => this.syncFromPreview();
    
    this.editorElement.addEventListener('scroll', this.editorScrollListener, { passive: true });
    this.previewElement.addEventListener('scroll', this.previewScrollListener, { passive: true });
  }

  /**
   * Sync preview when editor scrolls
   */
  private syncFromEditor(): void {
    if (this.isSyncing || !this.editorElement || !this.previewElement) return;
    
    this.isSyncing = true;
    const scrollPercentage = this.calculateScrollPercentage(this.editorElement);
    this.applyScrollPercentage(this.previewElement, scrollPercentage);
    
    // Use requestAnimationFrame for smooth 60fps sync
    requestAnimationFrame(() => {
      this.isSyncing = false;
    });
  }

  /**
   * Sync editor when preview scrolls
   */
  private syncFromPreview(): void {
    if (this.isSyncing || !this.editorElement || !this.previewElement) return;
    
    this.isSyncing = true;
    const scrollPercentage = this.calculateScrollPercentage(this.previewElement);
    this.applyScrollPercentage(this.editorElement, scrollPercentage);
    
    // Use requestAnimationFrame for smooth 60fps sync
    requestAnimationFrame(() => {
      this.isSyncing = false;
    });
  }

  /**
   * Calculate scroll percentage (0-1) for consistent sync
   */
  private calculateScrollPercentage(element: HTMLElement): number {
    const maxScroll = Math.max(1, element.scrollHeight - element.clientHeight);
    return element.scrollTop / maxScroll;
  }

  /**
   * Apply scroll percentage to target element
   */
  private applyScrollPercentage(element: HTMLElement, percentage: number): void {
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = percentage * maxScroll;
  }

  /**
   * Scroll to a specific position (used for search results)
   */
  scrollToSearchResult(element: HTMLElement, position: number): void {
    if (!element) return;
    
    // Temporarily disable sync during search scroll
    const wasSync = this.isSyncing;
    this.isSyncing = true;
    
    // Smooth scroll to position
    element.scrollTo({
      top: position,
      behavior: 'smooth'
    });

    // Re-enable sync after animation
    setTimeout(() => {
      this.isSyncing = wasSync;
    }, 500); // Allow time for smooth scroll animation
  }

  /**
   * Check if sync is currently active
   */
  isSyncActive(): boolean {
    return this.editorElement !== null && this.previewElement !== null;
  }

  /**
   * Clean up event listeners and references
   */
  cleanup(): void {
    if (this.editorElement && this.editorScrollListener) {
      this.editorElement.removeEventListener('scroll', this.editorScrollListener);
    }
    if (this.previewElement && this.previewScrollListener) {
      this.previewElement.removeEventListener('scroll', this.previewScrollListener);
    }
    
    console.log('ScrollSyncService: Cleaned up listeners');
    
    this.editorElement = null;
    this.previewElement = null;
    this.editorScrollListener = null;
    this.previewScrollListener = null;
    this.isSyncing = false;
  }

  /**
   * Force sync from editor to preview (useful for programmatic scrolling)
   */
  forceSyncFromEditor(): void {
    if (this.editorElement && this.previewElement) {
      const scrollPercentage = this.calculateScrollPercentage(this.editorElement);
      this.applyScrollPercentage(this.previewElement, scrollPercentage);
    }
  }

  /**
   * Force sync from preview to editor (useful for programmatic scrolling)
   */
  forceSyncFromPreview(): void {
    if (this.editorElement && this.previewElement) {
      const scrollPercentage = this.calculateScrollPercentage(this.previewElement);
      this.applyScrollPercentage(this.editorElement, scrollPercentage);
    }
  }
}