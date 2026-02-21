import { Component, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import { Subscription } from 'rxjs';
import { AiProvider, AiNonSensitiveSettings, AiKeyStatus } from '../../interfaces/ai-settings.interface';
import { AiSettingsService } from '../../services/ai-settings.service';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-ai-settings',
  templateUrl: './ai-settings.component.html',
  styleUrls: ['./ai-settings.component.scss'],
  standalone: false
})
export class AiSettingsComponent implements OnInit, OnDestroy {
  @Output() closed = new EventEmitter<void>();

  activeTab: AiProvider = 'openai';

  settings!: AiNonSensitiveSettings;
  keyStatus: AiKeyStatus = { openaiKeySet: false, anthropicKeySet: false, openaiEnvKey: false, anthropicEnvKey: false };

  openaiKeyInput: string = '';
  anthropicKeyInput: string = '';
  showOpenaiKey: boolean = false;
  showAnthropicKey: boolean = false;

  saveError: string = '';
  isSaving: boolean = false;

  private keyStatusSub!: Subscription;

  constructor(
    private aiSettingsService: AiSettingsService,
    private electronService: ElectronService
  ) {}

  ngOnInit(): void {
    const snap = this.aiSettingsService.snapshot;
    this.settings = {
      activeProvider: snap.activeProvider,
      openai: { ...snap.openai },
      anthropic: { ...snap.anthropic },
      bedrock: { ...snap.bedrock },
    };
    this.activeTab = snap.activeProvider;

    this.keyStatusSub = this.aiSettingsService.keyStatus$.subscribe(status => {
      this.keyStatus = status;
    });
  }

  ngOnDestroy(): void {
    if (this.keyStatusSub) this.keyStatusSub.unsubscribe();
  }

  setActiveTab(tab: AiProvider): void {
    this.activeTab = tab;
  }

  onBackdropClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.classList.contains('ai-settings-backdrop')) {
      this.close();
    }
  }

  close(): void {
    this.closed.emit();
  }

  async deleteKey(provider: 'openai' | 'anthropic'): Promise<void> {
    await this.electronService.aiKeyDelete(provider);
    await this.aiSettingsService.refreshKeyStatus();
  }

  async save(): Promise<void> {
    this.saveError = '';
    this.isSaving = true;
    try {
      this.aiSettingsService.save(this.settings);

      if (this.openaiKeyInput.trim()) {
        const result = await this.electronService.aiKeySet('openai', this.openaiKeyInput.trim());
        if (!result.success) {
          this.saveError = result.error || 'Failed to save OpenAI key';
          return;
        }
        this.openaiKeyInput = '';
      }

      if (this.anthropicKeyInput.trim()) {
        const result = await this.electronService.aiKeySet('anthropic', this.anthropicKeyInput.trim());
        if (!result.success) {
          this.saveError = result.error || 'Failed to save Anthropic key';
          return;
        }
        this.anthropicKeyInput = '';
      }

      await this.aiSettingsService.refreshKeyStatus();
      this.close();
    } catch (err: any) {
      this.saveError = err?.message || 'An error occurred while saving';
    } finally {
      this.isSaving = false;
    }
  }
}
