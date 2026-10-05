import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Observable } from 'rxjs';
import { ElectronService } from './electron.service';
import { AiSettingsService } from './ai-settings.service';
import { AiInvokeRequest, AiStreamChunk } from '../interfaces/ai-settings.interface';

@Injectable({ providedIn: 'root' })
export class AiService implements OnDestroy {
  constructor(
    private electronService: ElectronService,
    private settingsService: AiSettingsService,
    private ngZone: NgZone
  ) {}

  stream(request: AiInvokeRequest): Observable<AiStreamChunk> {
    return new Observable<AiStreamChunk>(subscriber => {
      const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const s = this.settingsService.snapshot;

      const payload: Record<string, unknown> = {
        requestId,
        provider: request.provider,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        history: request.history ?? [],
      };

      if (request.provider === 'openai') {
        payload['openaiModel']   = s.openai.model;
        payload['openaiBaseUrl'] = s.openai.baseUrl;
      } else if (request.provider === 'anthropic') {
        payload['anthropicModel']   = s.anthropic.model;
        payload['anthropicBaseUrl'] = s.anthropic.baseUrl;
      } else if (request.provider === 'bedrock') {
        payload['bedrockProfile'] = s.bedrock.profile;
        payload['bedrockRegion']  = s.bedrock.region;
        payload['bedrockModelId'] = s.bedrock.modelId;
      } else if (request.provider === 'claude-cli') {
        payload['claudeCliPath']       = s.claudeCli.cliPath;
        payload['claudeCliModel']      = s.claudeCli.model;
        // A session loaded from history must run in the directory recorded in
        // its transcript; new conversations use the configured scope.
        payload['claudeCliWorkingDir'] = request.workingDir || s.claudeCli.workingDir || '';
        payload['claudeCliConfigDir']  = s.claudeCli.configDir;
        payload['claudeCliIgnoreEnvAuth'] = s.claudeCli.ignoreEnvAuth !== false;
        payload['claudeCliSafeMode']   = s.claudeCli.safeMode !== false;
        // The CLI owns the transcript. Passing a sessionId makes it resume that
        // conversation, so we deliberately do NOT send `history` — replaying it
        // would duplicate the turns and break the cached prefix.
        payload['claudeCliSessionId']  = request.sessionId ?? null;
        payload['history'] = [];
      }

      const unsubscribeChunk = this.electronService.onAiStreamChunk((data) => {
        if (data.requestId !== requestId) return;
        this.ngZone.run(() => {
          if (data.type === 'chunk')         subscriber.next({ type: 'chunk', text: data.text });
          else if (data.type === 'session')  subscriber.next({ type: 'session', sessionId: data.sessionId });
          else if (data.type === 'usage')    subscriber.next({ type: 'usage', usage: data.usage });
          else if (data.type === 'done')     { subscriber.next({ type: 'done' }); subscriber.complete(); }
          else if (data.type === 'error')    subscriber.error(new Error(data.error ?? 'Stream error'));
        });
      });

      this.electronService.aiStreamStart(payload);

      return () => {
        unsubscribeChunk();
        this.electronService.aiStreamCancel(requestId).catch(() => {});
      };
    });
  }

  ngOnDestroy(): void {}
}
