import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { AiNonSensitiveSettings, AiKeyStatus } from '../interfaces/ai-settings.interface';
import { ElectronService } from './electron.service';

const LS_KEY = 'markdownEditorAiSettings';

const DEFAULTS: AiNonSensitiveSettings = {
  activeProvider: 'openai',
  openai:    { model: 'gpt-4o', baseUrl: '' },
  anthropic: { model: 'claude-sonnet-4-5' },
  bedrock:   { profile: 'default', region: 'us-east-1',
               modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
};

@Injectable({ providedIn: 'root' })
export class AiSettingsService {
  private _settings$ = new BehaviorSubject<AiNonSensitiveSettings>(this.load());
  public settings$ = this._settings$.asObservable();

  private _keyStatus$ = new BehaviorSubject<AiKeyStatus>({ openaiKeySet: false, anthropicKeySet: false, openaiEnvKey: false, anthropicEnvKey: false });
  public keyStatus$ = this._keyStatus$.asObservable();

  constructor(private electronService: ElectronService) {
    this.refreshKeyStatus();
  }

  get snapshot(): AiNonSensitiveSettings { return this._settings$.value; }

  save(settings: AiNonSensitiveSettings): void {
    this._settings$.next(settings);
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  }

  async refreshKeyStatus(): Promise<void> {
    this._keyStatus$.next(await this.electronService.aiKeyStatus());
  }

  private load(): AiNonSensitiveSettings {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { ...DEFAULTS };
      const p = JSON.parse(raw);
      return {
        activeProvider: p.activeProvider ?? DEFAULTS.activeProvider,
        openai:    { ...DEFAULTS.openai,    ...p.openai },
        anthropic: { ...DEFAULTS.anthropic, ...p.anthropic },
        bedrock:   { ...DEFAULTS.bedrock,   ...p.bedrock },
      };
    } catch (_) { return { ...DEFAULTS }; }
  }
}
