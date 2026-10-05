export type AiProvider = 'openai' | 'anthropic' | 'bedrock' | 'claude-cli';

export interface OpenAiProviderSettings {
  model: string;    // default: 'gpt-4o'
  baseUrl: string;  // default: '' (empty = use SDK default)
}

export interface AnthropicProviderSettings {
  model: string;    // default: 'claude-sonnet-4-5'
  baseUrl: string;  // default: '' (empty = use SDK default)
}

export interface BedrockProviderSettings {
  profile: string;  // default: 'default'
  region: string;   // default: 'us-east-1'
  modelId: string;  // default: 'anthropic.claude-3-5-sonnet-20241022-v2:0'
}

/**
 * Claude Code CLI provider — drives the local `claude` binary in print mode
 * instead of calling an HTTP API. Tools, MCP servers and slash commands are
 * always disabled; this provider is used purely as a chat transport.
 */
export interface ClaudeCliProviderSettings {
  cliPath: string;    // default: 'claude' (resolved on PATH)
  model: string;      // default: '' (empty = whatever the CLI is configured to use)
  /**
   * Working directory for NEW conversations. Nothing is written here — Claude
   * Code stores transcripts under <configDir>/projects/<slug-of-this-path>/.
   * It acts as a namespace: sessions started by this app share one bucket, so
   * the history picker can show them without your unrelated coding sessions.
   * Empty = Electron's userData dir.
   */
  workingDir: string;
  /**
   * CLAUDE_CONFIG_DIR for the spawned CLI — the config *home* holding the
   * account, credentials and plugins (e.g. "C:\Users\me\.claude-max").
   * Distinct from workingDir: this selects WHO you are, workingDir selects
   * WHERE the transcript is stored. Empty = the CLI's default (~/.claude).
   */
  configDir: string;
  /**
   * Strip inherited ANTHROPIC_* variables from the spawned CLI's environment
   * (default true). They outrank configDir, so a corporate ANTHROPIC_BASE_URL /
   * ANTHROPIC_AUTH_TOKEN exported in your shell would otherwise override the
   * account you picked above.
   */
  ignoreEnvAuth: boolean;
  /**
   * Pass --safe-mode (default true): disables CLAUDE.md, plugins, hooks and
   * custom agents, keeping the cached prefix stable. Turn OFF if your CLI gets
   * its endpoint or credentials from a settings file that safe-mode ignores.
   */
  safeMode: boolean;
}

export interface AiNonSensitiveSettings {
  activeProvider: AiProvider;
  openai: OpenAiProviderSettings;
  anthropic: AnthropicProviderSettings;
  bedrock: BedrockProviderSettings;
  claudeCli: ClaudeCliProviderSettings;
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

/** Token accounting for one turn — used to show whether the cache was hit. */
export interface AiUsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

export interface AiInvokeRequest {
  provider: AiProvider;
  prompt: string;
  systemPrompt?: string;
  history?: AiChatMessage[];
  /**
   * Claude CLI only: directory to run in. Sessions are keyed by cwd, so a
   * conversation loaded from history must be resumed from the exact directory
   * recorded in its transcript. Empty = the app's default location.
   */
  workingDir?: string | null;
  /**
   * Claude CLI only: the conversation to continue. When set, the CLI resumes
   * that session (`--resume`) and history is NOT re-sent — the CLI already has
   * it, and re-sending would invalidate the cached prefix.
   */
  sessionId?: string | null;
}

export interface AiStreamChunk {
  type: 'chunk' | 'done' | 'error' | 'session' | 'usage';
  text?: string;
  error?: string;
  /** Present on 'session': the CLI session id to resume on the next turn. */
  sessionId?: string;
  /** Present on 'usage': token counts for the finished turn. */
  usage?: AiUsageInfo;
}
