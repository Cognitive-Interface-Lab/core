import { CoreError } from "@core/contracts";
import type { CredentialStore } from "../credentials.js";
import type { ModelProvider } from "../provider.js";
import { ProviderRegistry } from "../registry.js";
import { AnthropicProvider } from "./anthropic.js";
import { AzureOpenAIProvider } from "./azure.js";
import { GoogleProvider } from "./google.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { PRESETS } from "./presets.js";

/**
 * The adapter for a preset, built on the given credentials: `AnthropicProvider` when the preset's
 * `api` is `"anthropic"`, `GoogleProvider` for `"google"`, `AzureOpenAIProvider` for `"azure"`, else
 * `OpenAICompatibleProvider`. Every adapter has a `listModels` (Azure's rejects), so it is not
 * optional here. Throws `CoreError` `not_found` for an id with no preset.
 */
export function presetProvider(
  id: string,
  credentials: CredentialStore,
  opts?: { fetch?: typeof fetch },
): ModelProvider & Required<Pick<ModelProvider, "listModels">> {
  if (!Object.hasOwn(PRESETS, id)) {
    throw new CoreError("not_found", `unknown provider "${id}"`);
  }
  const preset = PRESETS[id];
  const config = {
    id,
    credentials,
    preset,
    ...(opts?.fetch ? { fetch: opts.fetch } : {}),
  };
  const api = preset?.api ?? "openai";
  switch (api) {
    case "openai":
      return new OpenAICompatibleProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "google":
      return new GoogleProvider(config);
    case "azure":
      return new AzureOpenAIProvider(config);
    default: {
      const unreachable: never = api;
      throw new CoreError("unknown", `${id}: unsupported API "${String(unreachable)}"`, { provider: id });
    }
  }
}

/**
 * A new registry holding `presetProvider` for every preset id, sorted, then each of `opts.providers`.
 * A provider binds its credentials when it is made, so build a registry per use rather than share one.
 */
export function createPresetRegistry(
  credentials: CredentialStore,
  opts?: { fetch?: typeof fetch; providers?: ModelProvider[] },
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const id of Object.keys(PRESETS).sort()) {
    registry.register(presetProvider(id, credentials, { fetch: opts?.fetch }));
  }
  for (const provider of opts?.providers ?? []) registry.register(provider);
  return registry;
}
