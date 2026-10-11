export type Preset = { baseURL: string; requiresKey: boolean };

/** Hosted and local servers that speak the OpenAI chat-completions wire format. */
export const PRESETS: Record<string, Preset> = {
  openai: { baseURL: "https://api.openai.com/v1", requiresKey: true },
  ollama: { baseURL: "http://127.0.0.1:11434/v1", requiresKey: false },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", requiresKey: true },
  groq: { baseURL: "https://api.groq.com/openai/v1", requiresKey: true },
};
