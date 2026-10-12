import { describe, expect, it } from "vitest";
import { CredentialSummarySchema, StoredCredentialSchema } from "../src/index.js";

const apiKey = { kind: "api-key", apiKey: "sk-test-123" };
const oauth = { kind: "oauth", accessToken: "access-123", expiresAt: 1_800_000_000_000 };

describe("StoredCredentialSchema", () => {
  it("parses an api-key record, with and without the optional fields", () => {
    expect(StoredCredentialSchema.parse(apiKey)).toEqual(apiKey);
    const full = { ...apiKey, accountId: "acct-1", baseURL: "https://example.com/v1" };
    expect(StoredCredentialSchema.parse(full)).toEqual(full);
  });

  it("parses an oauth record, with and without the optional fields", () => {
    expect(StoredCredentialSchema.parse(oauth)).toEqual(oauth);
    const full = { ...oauth, refreshToken: "refresh-123", accountId: "acct-1", clientId: "client-1" };
    expect(StoredCredentialSchema.parse(full)).toEqual(full);
  });

  it("accepts an expiry of zero", () => {
    expect(StoredCredentialSchema.safeParse({ ...oauth, expiresAt: 0 }).success).toBe(true);
  });

  it.each([
    ["an empty api key", { ...apiKey, apiKey: "" }],
    ["an empty access token", { ...oauth, accessToken: "" }],
    ["an empty refresh token", { ...oauth, refreshToken: "" }],
    ["an empty account id", { ...apiKey, accountId: "" }],
    ["an empty client id", { ...oauth, clientId: "" }],
    ["an unknown kind", { kind: "password", apiKey: "sk-test-123" }],
    ["a missing kind", { apiKey: "sk-test-123" }],
    ["an extra key on an api-key record", { ...apiKey, extra: true }],
    ["an extra key on an oauth record", { ...oauth, extra: true }],
    ["an oauth field on an api-key record", { ...apiKey, accessToken: "access-123" }],
    ["an api-key field on an oauth record", { ...oauth, apiKey: "sk-test-123" }],
    ["a fractional expiry", { ...oauth, expiresAt: 1.5 }],
    ["a negative expiry", { ...oauth, expiresAt: -1 }],
    ["a missing expiry", { kind: "oauth", accessToken: "access-123" }],
    ["a base URL that is not a URL", { ...apiKey, baseURL: "not a url" }],
  ])("rejects %s", (_name, value) => {
    expect(StoredCredentialSchema.safeParse(value).success).toBe(false);
  });
});

describe("CredentialSummarySchema", () => {
  it("parses a summary, with and without the optional fields", () => {
    const minimal = { providerId: "openrouter", kind: "api-key" };
    expect(CredentialSummarySchema.parse(minimal)).toEqual(minimal);
    const full = { providerId: "cloudflare", kind: "oauth", accountId: "acct-1", expiresAt: 1_800_000_000_000 };
    expect(CredentialSummarySchema.parse(full)).toEqual(full);
  });

  it("never accepts a secret field", () => {
    const base = { providerId: "openrouter", kind: "api-key" };
    expect(CredentialSummarySchema.safeParse({ ...base, apiKey: "sk-test-123" }).success).toBe(false);
    expect(CredentialSummarySchema.safeParse({ ...base, accessToken: "access-123" }).success).toBe(false);
    expect(CredentialSummarySchema.safeParse({ ...base, refreshToken: "refresh-123" }).success).toBe(false);
  });

  it.each([
    ["an empty provider id", { providerId: "", kind: "api-key" }],
    ["an unknown kind", { providerId: "openrouter", kind: "password" }],
    ["a fractional expiry", { providerId: "cloudflare", kind: "oauth", expiresAt: 1.5 }],
    ["a negative expiry", { providerId: "cloudflare", kind: "oauth", expiresAt: -1 }],
  ])("rejects %s", (_name, value) => {
    expect(CredentialSummarySchema.safeParse(value).success).toBe(false);
  });
});
