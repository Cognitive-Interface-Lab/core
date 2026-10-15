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

describe("region and workspaceId on a saved key sign-in", () => {
  const withBoth = { ...apiKey, region: "us-west-2", workspaceId: "wrkspc_01" };

  it("parses an api-key record that carries both, unchanged", () => {
    expect(StoredCredentialSchema.parse(withBoth)).toEqual(withBoth);
  });

  it("parses an api-key record that carries only one of them", () => {
    const regionOnly = { ...apiKey, region: "eu-central-1" };
    const workspaceOnly = { ...apiKey, workspaceId: "wrkspc_01" };
    expect(StoredCredentialSchema.parse(regionOnly)).toEqual(regionOnly);
    expect(StoredCredentialSchema.parse(workspaceOnly)).toEqual(workspaceOnly);
  });

  it.each([
    ["an empty workspace id", { ...apiKey, workspaceId: "" }],
    ["an empty region", { ...apiKey, region: "" }],
    ["an upper-case region", { ...apiKey, region: "US-WEST-2" }],
    ["a region with spaces", { ...apiKey, region: "us west 2" }],
    ["a region with a slash", { ...apiKey, region: "a/b" }],
  ])("rejects %s", (_name, value) => {
    expect(StoredCredentialSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["a region", { ...oauth, region: "us-west-2" }],
    ["a workspace id", { ...oauth, workspaceId: "wrkspc_01" }],
  ])("rejects an oauth record with %s", (_name, value) => {
    expect(StoredCredentialSchema.safeParse(value).success).toBe(false);
  });

  it("accepts both on an api-key summary", () => {
    const summary = { providerId: "anthropic-aws", kind: "api-key", region: "us-west-2", workspaceId: "wrkspc_01" };
    expect(CredentialSummarySchema.parse(summary)).toEqual(summary);
  });

  it.each([
    ["an empty workspace id", { providerId: "anthropic-aws", kind: "api-key", workspaceId: "" }],
    ["an upper-case region", { providerId: "anthropic-aws", kind: "api-key", region: "US-WEST-2" }],
    ["a region with a slash", { providerId: "anthropic-aws", kind: "api-key", region: "a/b" }],
  ])("rejects a summary with %s", (_name, value) => {
    expect(CredentialSummarySchema.safeParse(value).success).toBe(false);
  });
});
