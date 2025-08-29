import { NgModule, APP_INITIALIZER } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { FileExplorerComponent } from './components/file-explorer/file-explorer.component';
import { MarkdownEditorComponent } from './components/markdown-editor/markdown-editor.component';
import { MarkdownPreviewComponent } from './components/markdown-preview/markdown-preview.component';
import { ThemeService } from './services/theme.service';

function initializeTheme(themeService: ThemeService) {
  return () => {
    // Ensure theme is applied immediately when app loads
    themeService.setTheme(themeService.getCurrentTheme());
  };
}

@NgModule({
  declarations: [
    AppComponent,
    FileExplorerComponent,
    MarkdownEditorComponent,
    MarkdownPreviewComponent
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    FormsModule
  ],
  providers: [
    ThemeService,
    {
      provide: APP_INITIALIZER,
      useFactory: initializeTheme,
      deps: [ThemeService],
      multi: true
    }
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
