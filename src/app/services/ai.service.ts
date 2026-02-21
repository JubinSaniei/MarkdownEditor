import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Observable } from 'rxjs';
import { ElectronService } from './electron.service';
import { AiSettingsService } from './ai-settings.service';
import { AiInvokeRequest, AiStreamChunk } from '../interfaces/ai-settings.interface';

@Injectable({ providedIn: 'root' })
export class AiService implements OnDestroy {
  private activeRequestId: string | null = null;

  constructor(
    private electronService: ElectronService,
    private settingsService: AiSettingsService,
    private ngZone: NgZone
  ) {}

  stream(request: AiInvokeRequest): Observable<AiStreamChunk> {
    return new Observable<AiStreamChunk>(subscriber => {
      const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.activeRequestId = requestId;
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
        payload['anthropicModel'] = s.anthropic.model;
      } else if (request.provider === 'bedrock') {
        payload['bedrockProfile'] = s.bedrock.profile;
        payload['bedrockRegion']  = s.bedrock.region;
        payload['bedrockModelId'] = s.bedrock.modelId;
      }

      this.electronService.onAiStreamChunk((data) => {
        if (data.requestId !== requestId) return;
        this.ngZone.run(() => {
          if (data.type === 'chunk')       subscriber.next({ type: 'chunk', text: data.text });
          else if (data.type === 'done')   { subscriber.next({ type: 'done' }); subscriber.complete(); }
          else if (data.type === 'error')  subscriber.error(new Error(data.error ?? 'Stream error'));
        });
      });

      this.electronService.aiStreamStart(payload);

      return () => {
        this.electronService.removeAiStreamChunkListener();
        if (this.activeRequestId === requestId) {
          this.electronService.aiStreamCancel(requestId);
          this.activeRequestId = null;
        }
      };
    });
  }

  ngOnDestroy(): void { this.electronService.removeAiStreamChunkListener(); }
}
