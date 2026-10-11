import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";

/** Collects what `run` writes, standing in for stdout and stderr. */
function capture() {
  let text = "";
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

async function runWith(argv: string[], env: Record<string, string | undefined> = {}) {
  const out = capture();
  const err = capture();
  const code = await run(argv, env, out, err);
  return { code, out: out.text, err: err.text };
}

/** Replaces global fetch with a stub that fails the test if anything tries to use the network. */
function forbidNetwork() {
  const stub = vi.fn(async () => {
    throw new Error("network call attempted");
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hello-gateway default route", () => {
  it("prints echo: hi and exits 0", async () => {
    const fetchStub = forbidNetwork();
    const { code, out, err } = await runWith(["hi"]);
    expect(code).toBe(0);
    expect(out).toBe("echo: hi\n");
    expect(err).toMatch(/^\[via mock:echo · \d+ ms · 1 attempt\(s\)\]\n$/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("joins several arguments into one prompt", async () => {
    const { code, out } = await runWith(["say", "it", "twice"]);
    expect(code).toBe(0);
    expect(out).toBe("echo: say it twice\n");
  });

  it("uses mock:echo when CORE_ROUTE is empty", async () => {
    const { code, out, err } = await runWith(["hi"], { CORE_ROUTE: "" });
    expect(code).toBe(0);
    expect(out).toBe("echo: hi\n");
    expect(err).toContain("[via mock:echo");
  });

  it("writes the answer to stdout only and the summary to stderr only", async () => {
    const { out, err } = await runWith(["hi"]);
    expect(out).not.toContain("[via");
    expect(err).not.toContain("echo: hi");
  });
});

describe("hello-gateway without a prompt", () => {
  for (const [label, argv] of [
    ["no arguments", []],
    ["an empty argument", [""]],
  ] as const) {
    it(`exits 2 with usage on stderr for ${label}`, async () => {
      const { code, out, err } = await runWith([...argv]);
      expect(code).toBe(2);
      expect(out).toBe("");
      expect(err).toContain("usage:");
      expect(err).toContain("CORE_ROUTE");
    });
  }
});

describe("hello-gateway fallback", () => {
  it("falls back from openai to the mock with no API key, in 2 attempts and with no network call", async () => {
    const fetchStub = forbidNetwork();
    const { code, out, err } = await runWith(["hi"], { CORE_ROUTE: "openai:gpt-4.1-mini,mock:echo" });
    expect(code).toBe(0);
    expect(out).toBe("echo: hi\n");
    expect(err).toMatch(/^\[via mock:echo · \d+ ms · 2 attempt\(s\)\]\n$/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("falls back past an unknown provider id", async () => {
    const fetchStub = forbidNetwork();
    const { code, out, err } = await runWith(["hi"], { CORE_ROUTE: "nope:x,mock:echo" });
    expect(code).toBe(0);
    expect(out).toBe("echo: hi\n");
    expect(err).toContain("2 attempt(s)");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("counts every step it had to try", async () => {
    forbidNetwork();
    const { err } = await runWith(["hi"], { CORE_ROUTE: "openai:gpt-4.1-mini,nope:x,mock:echo" });
    expect(err).toContain("[via mock:echo");
    expect(err).toContain("3 attempt(s)");
  });

  it("reads credentials from the env it is given, and falls back when the server rejects them", async () => {
    const secret = "sk-smoke-test-key-123";
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
      return new Response(JSON.stringify({ error: { message: `bad key ${secret}`, type: "auth" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);
    const { code, out, err } = await runWith(["hi"], {
      CORE_ROUTE: "openai:gpt-4.1-mini,mock:echo",
      CORE_OPENAI_API_KEY: secret,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
    expect(out).toBe("echo: hi\n");
    expect(err).toContain("2 attempt(s)");
    expect(out + err).not.toContain(secret);
  });
});

describe("hello-gateway failures", () => {
  it("exits 1 with an error line when no provider in the route is known", async () => {
    const fetchStub = forbidNetwork();
    const { code, out, err } = await runWith(["hi"], { CORE_ROUTE: "nope:x" });
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/^error: [a-z_]+: .+\n$/);
    expect(err).not.toContain("[via");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("exits 1 with an error line when a route entry is not provider:model", async () => {
    const { code, out, err } = await runWith(["hi"], { CORE_ROUTE: "nocolon" });
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/^error: bad_request: /);
  });

  it("exits 1 when every provider in the route fails", async () => {
    forbidNetwork();
    const { code, err } = await runWith(["hi"], { CORE_ROUTE: "openai:gpt-4.1-mini,nope:x" });
    expect(code).toBe(1);
    expect(err).toMatch(/^error: /);
  });
});
