import { describe, expect, it } from "vitest";
import type { ProvidersResponse } from "@core/contracts";
import { MemoryCredentialStore } from "@core/models";
import { createTestHandler, get, readJson } from "./helpers.js";

/**
 * GET /v1/providers over the server's own preset registry (`registryFor: undefined`, so not the
 * test helper's mock registry), with `saved` as the credential store's contents.
 */
async function providersWith(saved: ConstructorParameters<typeof MemoryCredentialStore>[0] = {}) {
  const handler = createTestHandler({
    credentialsFor: () => new MemoryCredentialStore(saved),
    registryFor: undefined,
  });
  const response = await handler.fetch(get("/v1/providers"));
  expect(response.status).toBe(200);
  return (await readJson<ProvidersResponse>(response)).providers;
}

describe("GET /v1/providers: openai-compatible, google and azure", () => {
  it("reports openai-compatible as not ready without a credential, although its preset does not require a key", async () => {
    const providers = await providersWith();
    expect(providers.find((p) => p.id === "openai-compatible")).toEqual({
      id: "openai-compatible",
      requiresKey: false,
      ready: false,
    });
  });

  it("reports openai-compatible as ready once the store holds a key and base URL for it", async () => {
    const providers = await providersWith({ "openai-compatible": { apiKey: "k-12345678", baseURL: "http://localhost:1234/v1" } });
    expect(providers.find((p) => p.id === "openai-compatible")).toEqual({
      id: "openai-compatible",
      requiresKey: false,
      ready: true,
    });
  });

  it("reports azure as needing a key and not ready without a credential", async () => {
    const providers = await providersWith();
    expect(providers.find((p) => p.id === "azure")).toEqual({ id: "azure", requiresKey: true, ready: false });
  });

  it("reports azure as ready once the store holds a key and endpoint for it", async () => {
    const providers = await providersWith({ azure: { apiKey: "k-12345678", baseURL: "https://myresource.openai.azure.com/openai" } });
    expect(providers.find((p) => p.id === "azure")).toEqual({ id: "azure", requiresKey: true, ready: true });
  });

  it("reports google as needing a key and not ready without a credential", async () => {
    const providers = await providersWith();
    expect(providers.find((p) => p.id === "google")).toEqual({ id: "google", requiresKey: true, ready: false });
  });

  it("reports google as ready once the store holds a key for it", async () => {
    const providers = await providersWith({ google: { apiKey: "k-12345678" } });
    expect(providers.find((p) => p.id === "google")).toEqual({ id: "google", requiresKey: true, ready: true });
  });

  it("keeps ollama ready without a credential", async () => {
    const providers = await providersWith();
    expect(providers.find((p) => p.id === "ollama")).toEqual({ id: "ollama", requiresKey: false, ready: true });
  });

  it("makes only the provider that has a credential ready", async () => {
    const providers = await providersWith({ azure: { apiKey: "k-12345678", baseURL: "https://myresource.openai.azure.com/openai" } });
    const ready = Object.fromEntries(providers.map((p) => [p.id, p.ready]));
    expect(ready["azure"]).toBe(true);
    expect(ready["openai-compatible"]).toBe(false);
    expect(ready["google"]).toBe(false);
    expect(ready["openai"]).toBe(false);
  });

  it("never returns a credential value in the response", async () => {
    const handler = createTestHandler({
      credentialsFor: () =>
        new MemoryCredentialStore({ "openai-compatible": { apiKey: "k-secret-98765", baseURL: "http://localhost:1234/v1" } }),
      registryFor: undefined,
    });
    const text = await (await handler.fetch(get("/v1/providers"))).text();
    expect(text).not.toContain("k-secret-98765");
    expect(text).not.toContain("localhost:1234");
  });
});
