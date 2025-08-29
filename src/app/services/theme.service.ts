import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type Theme = 'light' | 'dark';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly THEME_KEY = 'markdownEditorTheme';
  private _currentTheme = new BehaviorSubject<Theme>(this.getInitialTheme());

  public currentTheme$ = this._currentTheme.asObservable();

  constructor() {
    this.applyTheme(this._currentTheme.value);
  }

  private getInitialTheme(): Theme {
    const savedTheme = localStorage.getItem(this.THEME_KEY) as Theme;
    if (savedTheme && (savedTheme === 'light' || savedTheme === 'dark')) {
      return savedTheme;
    }
    
    // Default to system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    
    return 'light';
  }

  toggleTheme(): void {
    const newTheme: Theme = this._currentTheme.value === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
  }

  setTheme(theme: Theme): void {
    this._currentTheme.next(theme);
    this.applyTheme(theme);
    this.saveTheme(theme);
  }

  getCurrentTheme(): Theme {
    return this._currentTheme.value;
  }

  private applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }

  private saveTheme(theme: Theme): void {
    localStorage.setItem(this.THEME_KEY, theme);
  }
}