import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { CoreError } from "@core/contracts";
import type { LanguageModel } from "ai";
import type { ChatOptions } from "../provider.js";
import { AiSdkProvider, field, listField, malformedModels, type Connection } from "./ai-sdk.js";

const CLOUDFLARE_BASE_SUFFIX = "/ai/v1";
const CLOUDFLARE_SEARCH_SUFFIX = "/ai/models/search";
const CLOUDFLARE_PAGE_SIZE = 100;
const CLOUDFLARE_MAX_PAGES = 10;

/**
 * One adapter for every server that speaks the OpenAI chat-completions format (OpenAI, Ollama,
 * OpenRouter, Groq, Cloudflare Workers AI, ...), built on the Vercel AI SDK. The mapping shared
 * with the other AI SDK adapters lives in `AiSdkProvider`; this class builds the model and lists
 * the models.
 */
export class OpenAICompatibleProvider extends AiSdkProvider {
  protected languageModel(modelId: string, connection: Connection, call: { structuredOutput: boolean }): LanguageModel {
    const { baseURL, apiKey, credentials } = connection;
    const provider = createOpenAICompatible({
      name: this.id,
      baseURL,
      includeUsage: true,
      ...(apiKey ? { apiKey } : {}),
      ...(credentials?.headers ? { headers: credentials.headers } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      // Without this the SDK sends only `json_object`, and the endpoint never sees the JSON Schema.
      ...(call.structuredOutput ? { supportsStructuredOutputs: true } : {}),
    });
    return provider.chatModel(modelId);
  }

  async listModels(opts?: ChatOptions): Promise<string[]> {
    const connection = await this.connection();
    const headers: Record<string, string> = { ...connection.credentials?.headers };
    if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
    const get = (url: string) => this.getJson(url, headers, opts?.signal, connection.secrets);

    const ids: unknown[] = [];
    if (this.preset?.models === "cloudflare") {
      if (!connection.baseURL.endsWith(CLOUDFLARE_BASE_SUFFIX)) {
        throw new CoreError("bad_request", `${this.id}: cannot list models for this base URL`, {
          provider: this.id,
        });
      }
      const search = `${connection.baseURL.slice(0, -CLOUDFLARE_BASE_SUFFIX.length)}${CLOUDFLARE_SEARCH_SUFFIX}`;
      for (let page = 1; page <= CLOUDFLARE_MAX_PAGES; page++) {
        const body = await get(`${search}?task=Text%20Generation&per_page=${CLOUDFLARE_PAGE_SIZE}&page=${page}`);
        const items = listField(this.id, body, "result");
        for (const item of items) ids.push(field(item, "name"));
        if (items.length < CLOUDFLARE_PAGE_SIZE) break;
      }
    } else {
      const body = await get(`${connection.baseURL.replace(/\/+$/, "")}/models`);
      for (const item of listField(this.id, body, "data")) ids.push(field(item, "id"));
    }
    if (!ids.every((id): id is string => typeof id === "string" && id.length > 0)) {
      throw malformedModels(this.id);
    }
    return [...new Set(ids)].sort();
  }
}
