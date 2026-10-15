import { describe, expect, it } from "vitest";
import { EnvCredentialStore } from "../src/index.js";

describe("EnvCredentialStore region and workspaceId", () => {
  it("reads the key, region and workspace id for anthropic-aws", async () => {
    const store = new EnvCredentialStore({
      CORE_ANTHROPIC_AWS_API_KEY: "sk-test-123",
      CORE_ANTHROPIC_AWS_REGION: "us-west-2",
      CORE_ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_01",
    });
    expect(await store.get("anthropic-aws")).toEqual({
      apiKey: "sk-test-123",
      region: "us-west-2",
      workspaceId: "wrkspc_01",
    });
  });

  it("returns the region alone when only the region is set", async () => {
    const store = new EnvCredentialStore({ CORE_ANTHROPIC_AWS_REGION: "us-west-2" });
    expect(await store.get("anthropic-aws")).toEqual({ region: "us-west-2" });
  });

  it("returns the workspace id alone when only the workspace id is set", async () => {
    const store = new EnvCredentialStore({ CORE_ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_01" });
    expect(await store.get("anthropic-aws")).toEqual({ workspaceId: "wrkspc_01" });
  });

  it("treats empty strings as unset, and returns undefined when all five are empty", async () => {
    const store = new EnvCredentialStore({
      CORE_ANTHROPIC_AWS_API_KEY: "",
      CORE_ANTHROPIC_AWS_BASE_URL: "",
      CORE_ANTHROPIC_AWS_ACCOUNT_ID: "",
      CORE_ANTHROPIC_AWS_REGION: "",
      CORE_ANTHROPIC_AWS_WORKSPACE_ID: "",
    });
    expect(await store.get("anthropic-aws")).toBeUndefined();
  });

  it("omits the fields that are empty while returning the ones that are set", async () => {
    const store = new EnvCredentialStore({
      CORE_ANTHROPIC_AWS_API_KEY: "sk-test-123",
      CORE_ANTHROPIC_AWS_REGION: "",
      CORE_ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_01",
    });
    const credentials = await store.get("anthropic-aws");
    expect(credentials).toEqual({ apiKey: "sk-test-123", workspaceId: "wrkspc_01" });
    expect(credentials).not.toHaveProperty("region");
  });

  it("keeps providers apart: the plain anthropic variables do not read the aws ones", async () => {
    const store = new EnvCredentialStore({
      CORE_ANTHROPIC_AWS_REGION: "us-west-2",
      CORE_ANTHROPIC_API_KEY: "sk-test-456",
    });
    expect(await store.get("anthropic")).toEqual({ apiKey: "sk-test-456" });
    expect(await store.get("anthropic-aws")).toEqual({ region: "us-west-2" });
  });

  it("serialises to {} so nothing leaks through JSON.stringify", () => {
    const store = new EnvCredentialStore({
      CORE_ANTHROPIC_AWS_API_KEY: "sk-test-123",
      CORE_ANTHROPIC_AWS_REGION: "us-west-2",
      CORE_ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_01",
    });
    expect(JSON.stringify(store)).toBe("{}");
  });
});
