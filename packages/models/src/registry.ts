import { CoreError } from "@core/contracts";
import type { ModelProvider } from "./provider.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): this {
    if (this.providers.has(provider.id)) {
      throw new CoreError("bad_request", `provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): ModelProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new CoreError("not_found", `unknown provider "${id}"`);
    }
    return provider;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  /** Registered ids, sorted. */
  list(): string[] {
    return [...this.providers.keys()].sort();
  }
}
