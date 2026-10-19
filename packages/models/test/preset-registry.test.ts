import { describe, expect, it } from "vitest";
import { CoreError, type ChatRequest } from "@core/contracts";
import {
  AnthropicProvider,
  MemoryCredentialStore,
  OpenAICompatibleProvider,
  PRESETS,
  createPresetRegistry,
  presetProvider,
  type ModelProvider,
} from "../src/index.js";
import { completionResponse, respondWith } from "./fixtures/openai-responses.js";

const request: ChatRequest = {
  model: { provider: "openai", model: "gpt-test" },
  messages: [{ role: "user", content: "hi" }],
};

const presetIds = Object.keys(PRESETS);

function extraProvider(id: string): ModelProvider {
  return {
    id,
    capabilities: () => ({ streaming: false, tools: false, vision: false }),
    chat: async () => {
      throw new Error("not used");
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used");
    },
  } as unknown as ModelProvider;
}

describe("createPresetRegistry", () => {
  it("lists every preset id plus the extra providers", () => {
    const registry = createPresetRegistry(new MemoryCredentialStore(), {
      providers: [extraProvider("zz-extra"), extraProvider("aa-extra")],
    });
    expect(registry.list()).toEqual([...presetIds, "zz-extra", "aa-extra"].sort());
  });

  it("lists exactly the preset ids when no extra providers are given", () => {
    expect(createPresetRegistry(new MemoryCredentialStore()).list()).toEqual([...presetIds].sort());
  });

  it("gives an OpenAICompatibleProvider to a preset with no api or api openai, an AnthropicProvider to anthropic, and neither to any other api", () => {
    const registry = createPresetRegistry(new MemoryCredentialStore());
    for (const id of presetIds) {
      const provider = registry.get(id);
      const api: string = PRESETS[id]?.api ?? "openai";
      if (api === "openai") {
        expect(provider, id).toBeInstanceOf(OpenAICompatibleProvider);
      } else if (api === "anthropic") {
        expect(provider, id).toBeInstanceOf(AnthropicProvider);
      } else {
        expect(provider, id).not.toBeInstanceOf(OpenAICompatibleProvider);
        expect(provider, id).not.toBeInstanceOf(AnthropicProvider);
      }
    }
  });

  it("sends requests through the injected fetch", async () => {
    const fake = respondWith(() => completionResponse());
    const registry = createPresetRegistry(new MemoryCredentialStore({ openai: { apiKey: "sk-one" } }), {
      fetch: fake.fetch,
    });
    await registry.get("openai").chat(request);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url).toContain("api.openai.com");
  });

  it("does not share credentials between registries", async () => {
    const fake = respondWith(() => completionResponse());
    const first = createPresetRegistry(new MemoryCredentialStore({ openai: { apiKey: "key-one" } }), {
      fetch: fake.fetch,
    });
    const second = createPresetRegistry(new MemoryCredentialStore({ openai: { apiKey: "key-two" } }), {
      fetch: fake.fetch,
    });
    await first.get("openai").chat(request);
    await second.get("openai").chat(request);
    await first.get("openai").chat(request);
    expect(fake.requests.map((sent) => sent.headers.get("authorization"))).toEqual([
      "Bearer key-one",
      "Bearer key-two",
      "Bearer key-one",
    ]);
  });
});

describe("presetProvider", () => {
  it("builds the adapter for the preset's api", () => {
    const credentials = new MemoryCredentialStore();
    expect(presetProvider("openai", credentials)).toBeInstanceOf(OpenAICompatibleProvider);
    expect(presetProvider("anthropic", credentials)).toBeInstanceOf(AnthropicProvider);
  });

  it("throws not_found for an unknown id", () => {
    try {
      presetProvider("nope", new MemoryCredentialStore());
    } catch (error) {
      expect(CoreError.is(error)).toBe(true);
      expect((error as CoreError).code).toBe("not_found");
      return;
    }
    throw new Error("expected presetProvider to throw");
  });

  it("treats inherited object keys as unknown ids", () => {
    expect(() => presetProvider("toString", new MemoryCredentialStore())).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });
});
