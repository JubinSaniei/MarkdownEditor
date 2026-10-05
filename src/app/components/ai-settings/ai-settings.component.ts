import { Component, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import { Subscription } from 'rxjs';
import { AiProvider, AiNonSensitiveSettings, AiKeyStatus } from '../../interfaces/ai-settings.interface';
import { AiSettingsService } from '../../services/ai-settings.service';
import { ElectronService, AiConnectionTestResult } from '../../services/electron.service';

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

  // ── Connection test (per tab) ──────────────────────────────
  isTesting: boolean = false;
  testResult: AiConnectionTestResult | null = null;

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
      claudeCli: { ...snap.claudeCli },
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
    this.testResult = null; // a result from another provider would be misleading
  }

  /**
   * Probe the endpoint for the tab currently being edited.
   *
   * Tests the *unsaved* form values so you can iterate on a base URL without
   * committing it first. The key, however, comes from the main process — an
   * unsaved key in the input box is not used, so save before testing a new key.
   */
  async testConnection(): Promise<void> {
    this.isTesting = true;
    this.testResult = null;
    try {
      this.testResult = await this.electronService.aiTestConnection({
        provider: this.activeTab,
        openaiBaseUrl: this.settings.openai.baseUrl,
        openaiModel: this.settings.openai.model,
        anthropicBaseUrl: this.settings.anthropic.baseUrl,
        anthropicModel: this.settings.anthropic.model,
        bedrockProfile: this.settings.bedrock.profile,
        bedrockRegion: this.settings.bedrock.region,
        bedrockModelId: this.settings.bedrock.modelId,
        claudeCliPath: this.settings.claudeCli.cliPath,
        claudeCliModel: this.settings.claudeCli.model,

        claudeCliConfigDir: this.settings.claudeCli.configDir,
        claudeCliWorkingDir: this.settings.claudeCli.workingDir,
        claudeCliIgnoreEnvAuth: this.settings.claudeCli.ignoreEnvAuth !== false,
        claudeCliSafeMode: this.settings.claudeCli.safeMode !== false,
      });
    } catch (err: any) {
      this.testResult = { ok: false, message: err?.message || 'Test failed' };
    } finally {
      this.isTesting = false;
    }
  }

  /** Human-readable explanation of where the credential came from. */
  get keySourceLabel(): string {
    switch (this.testResult?.keySource) {
      case 'saved':         return 'saved key (safeStorage)';
      case 'saved-corrupt': return 'saved key could NOT be decrypted — fell back to environment variable';
      case 'env':           return 'environment variable';
      case 'none':          return 'no key found';
      default:              return this.testResult?.keySource ?? '';
    }
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
