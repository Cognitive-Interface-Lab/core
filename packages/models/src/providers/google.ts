import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { CoreError } from "@core/contracts";
import type { LanguageModel } from "ai";
import type { ChatOptions } from "../provider.js";
import { AiSdkProvider, field, listField, malformedModels, type Connection } from "./ai-sdk.js";

const KEY_HEADER = "x-goog-api-key";
const MODEL_PREFIX = "models/";
const GENERATE_METHOD = "generateContent";
const LIST_PAGE_SIZE = 1000;
const LIST_MAX_PAGES = 10;

/** Google Gemini through the Generative Language API, built on the Vercel AI SDK. */
export class GoogleProvider extends AiSdkProvider {
  protected languageModel(modelId: string, connection: Connection): LanguageModel {
    const apiKey = this.#requireKey(connection);
    // `baseURL` and `apiKey` are always passed: without the key the SDK reads
    // GOOGLE_GENERATIVE_AI_API_KEY from the environment, which core must never do.
    const provider = createGoogleGenerativeAI({
      name: this.id,
      baseURL: connection.baseURL,
      apiKey,
      ...(connection.credentials?.headers ? { headers: connection.credentials.headers } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    return provider.chat(modelId);
  }

  async listModels(opts?: ChatOptions): Promise<string[]> {
    const connection = await this.connection();
    const apiKey = this.#requireKey(connection);
    const headers: Record<string, string> = { ...connection.credentials?.headers, [KEY_HEADER]: apiKey };
    const base = connection.baseURL.replace(/\/+$/, "");

    const names: unknown[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const query = `pageSize=${LIST_PAGE_SIZE}${pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`;
      const body = await this.getJson(`${base}/models?${query}`, headers, opts?.signal, connection.secrets);
      for (const item of listField(this.id, body, "models")) {
        const methods = field(item, "supportedGenerationMethods");
        if (Array.isArray(methods) && methods.includes(GENERATE_METHOD)) names.push(field(item, "name"));
      }
      const next = field(body, "nextPageToken");
      if (next === undefined || next === "") break;
      if (typeof next !== "string") throw malformedModels(this.id);
      pageToken = next;
    }
    if (!names.every((name): name is string => typeof name === "string" && name.length > 0)) {
      throw malformedModels(this.id);
    }
    return [...new Set(names.map((name) => (name.startsWith(MODEL_PREFIX) ? name.slice(MODEL_PREFIX.length) : name)))].sort();
  }

  /** Gemini always needs a key, whatever the preset says. */
  #requireKey(connection: Connection): string {
    if (!connection.apiKey) {
      throw new CoreError("auth", `${this.id}: no API key configured`, { provider: this.id });
    }
    return connection.apiKey;
  }
}
