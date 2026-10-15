export type Preset = {
  /** May contain `{accountId}` and `{region}`, replaced from `Credentials`. */
  baseURL: string;
  requiresKey: boolean;
  /** Also needs `Credentials.workspaceId` (Claude Platform on AWS). */
  requiresWorkspace?: boolean;
  /** Wire format, so which adapter serves it; omitted means `"openai"` (chat completions). */
  api?: "openai" | "anthropic";
  /** How the server lists its models; omitted means `"openai"` (`GET /models`). */
  models?: "openai" | "cloudflare" | "anthropic";
};

/** Every built-in provider; `api` names the adapter that serves it. */
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
  vercel: { baseURL: "https://ai-gateway.vercel.sh/v1", requiresKey: true },
  anthropic: { baseURL: "https://api.anthropic.com/v1", requiresKey: true, api: "anthropic", models: "anthropic" },
  "anthropic-aws": {
    baseURL: "https://aws-external-anthropic.{region}.api.aws/v1",
    requiresKey: true,
    requiresWorkspace: true,
    api: "anthropic",
    models: "anthropic",
  },
};
