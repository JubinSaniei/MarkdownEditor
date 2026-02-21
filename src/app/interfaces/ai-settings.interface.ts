export type AiProvider = 'openai' | 'anthropic' | 'bedrock';

export interface OpenAiProviderSettings {
  model: string;    // default: 'gpt-4o'
  baseUrl: string;  // default: '' (empty = use SDK default)
}

export interface AnthropicProviderSettings {
  model: string;    // default: 'claude-sonnet-4-5'
}

export interface BedrockProviderSettings {
  profile: string;  // default: 'default'
  region: string;   // default: 'us-east-1'
  modelId: string;  // default: 'anthropic.claude-3-5-sonnet-20241022-v2:0'
}

export interface AiNonSensitiveSettings {
  activeProvider: AiProvider;
  openai: OpenAiProviderSettings;
  anthropic: AnthropicProviderSettings;
  bedrock: BedrockProviderSettings;
}

export interface AiKeyStatus {
  openaiKeySet: boolean;
  anthropicKeySet: boolean;
  openaiEnvKey: boolean;
  anthropicEnvKey: boolean;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiInvokeRequest {
  provider: AiProvider;
  prompt: string;
  systemPrompt?: string;
  history?: AiChatMessage[];
}

export interface AiStreamChunk {
  type: 'chunk' | 'done' | 'error';
  text?: string;
  error?: string;
}
