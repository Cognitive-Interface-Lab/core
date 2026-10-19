import { afterEach, describe, expect, it } from "vitest";
import { PRESETS } from "@core/models";
import { KEY_PAGES } from "../src/commands/login.js";
import { run } from "../src/run.js";
import { cleanupFakeIo, fakeIo, type FakeIo } from "./fake-io.js";

afterEach(cleanupFakeIo);

type Call = { url: string; method: string; headers: Headers };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const modelList = (ids: string[]) => json({ object: "list", data: ids.map((id) => ({ id })) });

const googleModels = json({ models: [{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] }] });

/** An injected `fetch` that records every call and answers with `answer` (provider traffic only). */
function providers(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers) };
    calls.push(call);
    return answer(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

async function saved(fake: FakeIo, provider: string): Promise<unknown> {
  const text = await fake.secrets.get(provider);
  return text === undefined ? undefined : JSON.parse(text);
}

function expectNoSecrets(fake: FakeIo, secrets: string[]): void {
  for (const secret of secrets) {
    expect(fake.stdout()).not.toContain(secret);
    expect(fake.stderr()).not.toContain(secret);
  }
}

const SYNOPSIS = "usage: core login <provider> [--key] [--browser] [--account-id <id>] [--no-open]";

const BASE_URL_RULE = "the base URL must start with https://, or with http:// for localhost or 127.0.0.1 only";
const COMPATIBLE_KEY_RULE = "an API key is required; for a server that ignores keys, enter any placeholder";
const AZURE_ENDPOINT_RULE = "the Azure OpenAI endpoint must be an https:// URL, such as https://<resource>.openai.azure.com/openai";
const AZURE_KEY_RULE = "an API key is required";
const AZURE_NOT_VERIFIED = "not verified: Azure OpenAI cannot list deployments\n";

/** A refused value: exit code 2, `error: <rule>` then the usage text, nothing on stdout, nothing saved, nothing sent. */
async function expectRefused(code: number, fake: FakeIo, calls: Call[], rule: string): Promise<void> {
  expect(code).toBe(2);
  expect(fake.stdout()).toBe("");
  expect(fake.stderr().split("\n")[0]).toBe(`error: ${rule}`);
  expect(fake.stderr()).toContain(SYNOPSIS);
  expect(calls).toHaveLength(0);
  expect(await fake.secrets.list()).toEqual([]);
}

describe("core login openai-compatible", () => {
  const KEY = "sk-compat-secret-111";
  const URL_TYPED = "https://proxy.example.com/v1";

  it("asks the base URL, then the key; lists {baseURL}/models with the key; saves both", async () => {
    const http = providers(() => modelList(["m1", "m2", "m3"]));
    const fake = fakeIo({ answers: { line: [URL_TYPED], secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "openai-compatible"], fake.io)).toBe(0);

    expect(fake.asked).toHaveLength(2);
    expect(fake.asked[0]).toMatch(/base url/i);
    expect(fake.asked[1]).toMatch(/api key/i);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.method).toBe("GET");
    expect(http.calls[0]?.url).toBe("https://proxy.example.com/v1/models");
    expect(http.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(fake.stdout()).toBe("Signed in to openai-compatible (3 models available). Saved in memory.\n");
    expect(fake.stderr()).toBe("");
    expect(await saved(fake, "openai-compatible")).toEqual({ kind: "api-key", apiKey: KEY, baseURL: URL_TYPED });
    expect(await fake.secrets.list()).toEqual(["openai-compatible"]);
    expectNoSecrets(fake, [KEY]);
  });

  it.each([
    ["a localhost address over http", "http://localhost:1234/v1"],
    ["a 127.0.0.1 address over http", "http://127.0.0.1:1234/v1"],
    ["an https address", "https://proxy.example.com/v1"],
  ])("accepts %s: %s", async (_name, baseURL) => {
    const http = providers(() => modelList(["m1"]));
    const fake = fakeIo({ answers: { line: [baseURL], secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "openai-compatible"], fake.io)).toBe(0);

    expect(http.calls.map((call) => call.url)).toEqual([`${baseURL}/models`]);
    expect(fake.stdout()).toBe("Signed in to openai-compatible (1 models available). Saved in memory.\n");
    expect(await saved(fake, "openai-compatible")).toEqual({ kind: "api-key", apiKey: KEY, baseURL });
    expectNoSecrets(fake, [KEY]);
  });

  it("saves the base URL as typed, with the surrounding spaces trimmed", async () => {
    const http = providers(() => modelList(["m1"]));
    const fake = fakeIo({ answers: { line: [`  ${URL_TYPED}  `], secret: [`  ${KEY}  `] }, fetch: http.fetch });

    expect(await run(["login", "openai-compatible"], fake.io)).toBe(0);

    expect(http.calls.map((call) => call.url)).toEqual(["https://proxy.example.com/v1/models"]);
    expect(http.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(await saved(fake, "openai-compatible")).toEqual({ kind: "api-key", apiKey: KEY, baseURL: URL_TYPED });
  });

  it.each([
    ["a private-network address over http", "http://192.168.1.5/v1"],
    ["a host that only starts with localhost", "http://localhost.example.com/v1"],
    ["a host that only starts with 127.0.0.1", "http://127.0.0.1.example.com/v1"],
    ["localhost as the userinfo of another host", "http://localhost@evil.example.com/v1"],
    ["the IPv6 loopback, which is not one of the two allowed hosts", "http://[::1]:1234/v1"],
    ["another scheme", "ftp://proxy.example.com/v1"],
    ["an address with no scheme", "proxy.example.com/v1"],
  ])("refuses %s: %j", async (_name, baseURL) => {
    const http = providers(() => modelList(["m1"]));
    const fake = fakeIo({ answers: { line: [baseURL], secret: [KEY] }, fetch: http.fetch });

    const code = await run(["login", "openai-compatible"], fake.io);

    await expectRefused(code, fake, http.calls, BASE_URL_RULE);
    expectNoSecrets(fake, [KEY]);
  });

  it.each([
    ["an empty key", ""],
    ["a blank key", "   "],
    ["end of input at the key prompt", undefined],
  ])("refuses %s, sends nothing and saves nothing", async (_name, key) => {
    const http = providers(() => modelList(["m1"]));
    const fake = fakeIo({ answers: { line: [URL_TYPED], secret: [key] }, fetch: http.fetch });

    const code = await run(["login", "openai-compatible"], fake.io);

    await expectRefused(code, fake, http.calls, COMPATIBLE_KEY_RULE);
    expect(fake.asked).toHaveLength(2);
  });

  it("opens no key page and prints no key-page text, even in a terminal", async () => {
    const http = providers(() => modelList(["m1"]));
    const fake = fakeIo({ interactive: true, answers: { line: [URL_TYPED], secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "openai-compatible"], fake.io)).toBe(0);

    expect(fake.opened).toEqual([]);
    expect(fake.stderr()).not.toContain("API key on this page");
    expect(fake.stderr()).not.toContain("paste it below");
  });

  it("saves nothing and returns 1 when the server rejects the key", async () => {
    const http = providers(() => json({ error: { message: "bad key" } }, 401));
    const fake = fakeIo({ answers: { line: [URL_TYPED], secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "openai-compatible"], fake.io)).toBe(1);

    expect(http.calls).toHaveLength(1);
    expect(fake.stderr()).toMatch(/^error: auth: /);
    expect(fake.stdout()).toBe("");
    expect(await fake.secrets.list()).toEqual([]);
    expectNoSecrets(fake, [KEY]);
  });
});

describe("core login azure", () => {
  const KEY = "azure-secret-key-222";
  const ENDPOINT = "https://myresource.openai.azure.com/openai";

  it("saves the endpoint and key without sending any request, and says it did not verify", async () => {
    const http = providers(() => json({}));
    const fake = fakeIo({ answers: { line: [ENDPOINT], secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "azure"], fake.io)).toBe(0);

    expect(fake.asked).toHaveLength(2);
    expect(fake.asked[0]).toMatch(/endpoint/i);
    expect(fake.asked[1]).toMatch(/api key/i);
    expect(http.calls).toHaveLength(0);
    expect(fake.stdout()).toBe("Signed in to azure. Saved in memory.\n");
    expect(fake.stderr()).toBe(AZURE_NOT_VERIFIED);
    expect(await saved(fake, "azure")).toEqual({ kind: "api-key", apiKey: KEY, baseURL: ENDPOINT });
    expect(await fake.secrets.list()).toEqual(["azure"]);
    expectNoSecrets(fake, [KEY]);
  });

  it.each([
    ["the bare endpoint, as the Azure portal shows it", "https://my-res.openai.azure.com/"],
    ["the endpoint with /openai", "https://my-res.openai.azure.com/openai"],
    [
      "a full deployment URL",
      "https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
    ],
  ])("saves the endpoint's origin plus /openai as the base URL, from %s", async (_name, endpoint) => {
    const http = providers(() => json({}));
    const fake = fakeIo({ answers: { line: [endpoint], secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "azure"], fake.io)).toBe(0);

    expect(await saved(fake, "azure")).toEqual({
      kind: "api-key",
      apiKey: KEY,
      baseURL: "https://my-res.openai.azure.com/openai",
    });
    expect(http.calls).toHaveLength(0);
    expectNoSecrets(fake, [KEY]);
  });

  it("saves the endpoint and key trimmed", async () => {
    const http = providers(() => json({}));
    const fake = fakeIo({ answers: { line: [`  ${ENDPOINT}  `], secret: [`  ${KEY}  `] }, fetch: http.fetch });

    expect(await run(["login", "azure"], fake.io)).toBe(0);

    expect(await saved(fake, "azure")).toEqual({ kind: "api-key", apiKey: KEY, baseURL: ENDPOINT });
    expect(http.calls).toHaveLength(0);
  });

  it("still says it did not verify when it is also showing the key page", async () => {
    const http = providers(() => json({}));
    const fake = fakeIo({ interactive: true, answers: { line: [ENDPOINT], secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "azure"], fake.io)).toBe(0);

    expect(fake.stdout()).toBe("Signed in to azure. Saved in memory.\n");
    expect(fake.stderr()).toContain(AZURE_NOT_VERIFIED);
    expect(http.calls).toHaveLength(0);
    expectNoSecrets(fake, [KEY]);
  });

  it.each([
    ["an http endpoint", "http://myresource.openai.azure.com/openai"],
    ["an http localhost endpoint, which only openai-compatible allows", "http://localhost:1234/openai"],
    ["an endpoint with no scheme", "myresource.openai.azure.com/openai"],
    ["another scheme", "ftp://myresource.openai.azure.com/openai"],
  ])("refuses %s: %j", async (_name, endpoint) => {
    const http = providers(() => json({}));
    const fake = fakeIo({ answers: { line: [endpoint], secret: [KEY] }, fetch: http.fetch });

    const code = await run(["login", "azure"], fake.io);

    await expectRefused(code, fake, http.calls, AZURE_ENDPOINT_RULE);
    expectNoSecrets(fake, [KEY]);
  });

  it.each([
    ["an empty key", ""],
    ["a blank key", "   "],
    ["end of input at the key prompt", undefined],
  ])("refuses %s and saves nothing", async (_name, key) => {
    const http = providers(() => json({}));
    const fake = fakeIo({ answers: { line: [ENDPOINT], secret: [key] }, fetch: http.fetch });

    const code = await run(["login", "azure"], fake.io);

    await expectRefused(code, fake, http.calls, AZURE_KEY_RULE);
  });
});

describe("core login google", () => {
  const KEY = "AIza-google-secret-333";

  it("asks one secret, lists the models with the key in a header, and saves the key alone", async () => {
    const http = providers(() => googleModels);
    const fake = fakeIo({ answers: { secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "google"], fake.io)).toBe(0);

    expect(fake.asked).toEqual(["Google Gemini API key: "]);
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(call?.method).toBe("GET");
    const url = new URL(call?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(url.searchParams.get("pageSize")).toBe("1000");
    expect(call?.headers.get("x-goog-api-key")).toBe(KEY);
    expect(call?.url).not.toContain(KEY);
    expect(fake.stdout()).toBe("Signed in to google (1 models available). Saved in memory.\n");
    expect(fake.stderr()).toBe("");
    const record = await saved(fake, "google");
    expect(record).toEqual({ kind: "api-key", apiKey: KEY });
    expect(record).not.toHaveProperty("baseURL");
    expectNoSecrets(fake, [KEY]);
  });

  it("trims what was typed", async () => {
    const http = providers(() => googleModels);
    const fake = fakeIo({ answers: { secret: [`  ${KEY}  `] }, fetch: http.fetch });

    expect(await run(["login", "google"], fake.io)).toBe(0);

    expect(http.calls[0]?.headers.get("x-goog-api-key")).toBe(KEY);
    expect(await saved(fake, "google")).toEqual({ kind: "api-key", apiKey: KEY });
  });

  it("opens its key page, then asks for the key, in a terminal", async () => {
    const http = providers(() => googleModels);
    const fake = fakeIo({ interactive: true, answers: { secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "google"], fake.io)).toBe(0);

    expect(fake.opened).toEqual([KEY_PAGES["google"]]);
    expect(fake.stderr()).toContain(KEY_PAGES["google"]);
    expectNoSecrets(fake, [KEY]);
  });

  it.each([
    ["an empty key", ""],
    ["a blank key", "   "],
    ["end of input", undefined],
  ])("returns 2 and saves nothing for %s", async (_name, key) => {
    const http = providers(() => googleModels);
    const fake = fakeIo({ answers: { secret: [key] }, fetch: http.fetch });

    expect(await run(["login", "google"], fake.io)).toBe(2);

    expect(fake.stderr()).toContain("nothing entered");
    expect(http.calls).toHaveLength(0);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("saves nothing and returns 1 when Google rejects the key", async () => {
    const http = providers(() => json({ error: { code: 401, message: "unauthenticated" } }, 401));
    const fake = fakeIo({ answers: { secret: [KEY] }, fetch: http.fetch });

    expect(await run(["login", "google"], fake.io)).toBe(1);

    expect(http.calls).toHaveLength(1);
    expect(fake.stderr()).toMatch(/^error: auth: /);
    expect(await fake.secrets.list()).toEqual([]);
    expectNoSecrets(fake, [KEY]);
  });
});

describe("core help login: the new providers", () => {
  const NEW = ["openai-compatible", "google", "azure"];

  async function helpLines(argv: string[]): Promise<string[]> {
    const fake = fakeIo();
    expect(await run(argv, fake.io)).toBe(0);
    return fake.stdout().split("\n");
  }

  /** The column where a row's description starts. */
  const column = (lines: string[], name: string): number => {
    const line = lines.find((candidate) => candidate.startsWith(`  ${name} `)) ?? "";
    return 2 + name.length + line.slice(2 + name.length).search(/\S/);
  };

  it("lists a row for each, after the ollama row, with the text in the same column as openrouter's", async () => {
    const lines = await helpLines(["login", "--help"]);

    const ollamaAt = lines.findIndex((line) => line.startsWith("  ollama "));
    expect(ollamaAt).toBeGreaterThan(0);
    expect(column(lines, "openrouter")).toBeGreaterThan(2 + "openrouter".length);
    for (const id of NEW) {
      const at = lines.findIndex((line) => line.startsWith(`  ${id} `));
      expect(at, `${id} row`).toBeGreaterThan(ollamaAt);
      expect(lines[at]?.slice(2 + id.length).trim().length, `${id} text`).toBeGreaterThan(0);
      expect(column(lines, id), `${id} column`).toBe(column(lines, "openrouter"));
    }
  });

  it("leaves the synopsis line unchanged", async () => {
    const lines = await helpLines(["login", "--help"]);
    expect(lines[0]).toBe(SYNOPSIS);
  });

  it("is the same text from `core help login`", async () => {
    const viaHelp = await helpLines(["help", "login"]);
    const viaFlag = await helpLines(["login", "--help"]);
    expect(viaHelp).toEqual(viaFlag);
    expect(viaHelp.some((line) => line.startsWith("  azure "))).toBe(true);
  });
});

describe("core status: the new providers", () => {
  /** The id column `core status` prints: the longest preset id, then two spaces. */
  const idWidth = Math.max(...Object.keys(PRESETS).map((id) => id.length)) + 2;
  const row = (id: string, state: string) => `${id.padEnd(idWidth)}${state}`;
  const rowFor = (fake: FakeIo, provider: string) =>
    fake.stdout().split("\n").find((line) => line.split(/\s+/)[0] === provider);

  it.each(["openai-compatible", "google", "azure"])("lists %s as not signed in", async (id) => {
    const fake = fakeIo();
    expect(await run(["status"], fake.io)).toBe(0);
    expect(rowFor(fake, id)).toBe(row(id, "not signed in"));
    expect(fake.stderr()).toBe("");
  });
});
