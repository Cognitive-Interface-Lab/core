import { createAnthropic } from "@ai-sdk/anthropic";
import { CoreError } from "@core/contracts";
import type { LanguageModel } from "ai";
import type { ChatOptions } from "../provider.js";
import { AiSdkProvider, field, listField, malformedModels, type Connection } from "./ai-sdk.js";

const ANTHROPIC_VERSION = "2023-06-01";
const WORKSPACE_HEADER = "anthropic-workspace-id";
const LIST_PAGE_SIZE = 1000;
const LIST_MAX_PAGES = 10;
/** The newest model line that still accepts `temperature`. */
const LAST_TEMPERATURE_VERSION: readonly [number, number] = [4, 6];

/**
 * `claude-<family>-<major>[-<minor>]...` or `claude-<major>[-<minor>]-<family>...`. The minor has
 * one or two digits, so a date suffix such as `-20250929` is not a minor.
 */
const FAMILY_FIRST = /^claude-[a-z]+-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/;
const VERSION_FIRST = /^claude-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?-[a-z]/;

/**
 * Claude models through the Anthropic Messages API, built on the Vercel AI SDK. One adapter serves
 * both the Claude API and Claude Platform on AWS: they differ only in the address and the
 * `anthropic-workspace-id` header, which come from the preset and the credentials.
 */
export class AnthropicProvider extends AiSdkProvider {
  protected languageModel(modelId: string, connection: Connection): LanguageModel {
    const apiKey = this.#requireKey(connection);
    // `baseURL` and `apiKey` are always passed: without them the SDK reads ANTHROPIC_BASE_URL and
    // ANTHROPIC_API_KEY from the environment, which core must never do.
    const provider = createAnthropic({
      name: this.id,
      baseURL: connection.baseURL,
      apiKey,
      headers: this.#headers(connection),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    return provider.messages(modelId);
  }

  /** Claude models from 4.7 on reject `temperature` with a 400; anything unparseable gets none. */
  protected override acceptsTemperature(modelId: string): boolean {
    const match = FAMILY_FIRST.exec(modelId) ?? VERSION_FIRST.exec(modelId);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = match[2] === undefined ? 0 : Number(match[2]);
    const [lastMajor, lastMinor] = LAST_TEMPERATURE_VERSION;
    return major < lastMajor || (major === lastMajor && minor <= lastMinor);
  }

  async listModels(opts?: ChatOptions): Promise<string[]> {
    const connection = await this.connection();
    const apiKey = this.#requireKey(connection);
    const headers: Record<string, string> = {
      ...connection.credentials?.headers,
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      ...workspaceHeader(connection),
    };
    const base = connection.baseURL.replace(/\/+$/, "");

    const ids: unknown[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const query = `limit=${LIST_PAGE_SIZE}${afterId === undefined ? "" : `&after_id=${encodeURIComponent(afterId)}`}`;
      const body = await this.getJson(`${base}/models?${query}`, headers, opts?.signal, connection.secrets);
      for (const item of listField(this.id, body, "data")) ids.push(field(item, "id"));
      if (field(body, "has_more") !== true) break;
      const lastId = field(body, "last_id");
      if (typeof lastId !== "string" || lastId.length === 0) throw malformedModels(this.id);
      afterId = lastId;
    }
    if (!ids.every((id): id is string => typeof id === "string" && id.length > 0)) {
      throw malformedModels(this.id);
    }
    return [...new Set(ids)].sort();
  }

  /** Anthropic always needs a key, whatever the preset says. */
  #requireKey(connection: Connection): string {
    if (!connection.apiKey) {
      throw new CoreError("auth", `${this.id}: no API key configured`, { provider: this.id });
    }
    return connection.apiKey;
  }

  #headers(connection: Connection): Record<string, string> {
    return { ...connection.credentials?.headers, ...workspaceHeader(connection) };
  }
}

function workspaceHeader(connection: Connection): Record<string, string> {
  const workspaceId = connection.credentials?.workspaceId;
  return workspaceId ? { [WORKSPACE_HEADER]: workspaceId } : {};
}
