export type Preset = {
  /** May contain `{accountId}`, replaced from `Credentials.accountId`. */
  baseURL: string;
  requiresKey: boolean;
  /** How the server lists its models; omitted means `"openai"` (`GET /models`). */
  models?: "openai" | "cloudflare";
};

/** Hosted and local servers that speak the OpenAI chat-completions wire format. */
export const PRESETS: Record<string, Preset> = {
  openai: { baseURL: "https://api.openai.com/v1", requiresKey: true },
  ollama: { baseURL: "http://127.0.0.1:11434/v1", requiresKey: false },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", requiresKey: true },
  groq: { baseURL: "https://api.groq.com/openai/v1", requiresKey: true },
  cloudflare: {
    baseURL: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
    requiresKey: true,
    models: "cloudflare",
  },
};
