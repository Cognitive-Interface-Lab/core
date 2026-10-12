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

/** Replaces global fetch with a stub that never answers until the request is aborted. */
function hangingNetwork() {
  const stub = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
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

  it("lists CORE_TIMEOUT_MS in the usage text", async () => {
    const { err } = await runWith([]);
    expect(err).toContain("CORE_TIMEOUT_MS");
  });
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
    expect(err).toMatch(/^(attempt .+\n)*error: [a-z_]+: .+\n$/);
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
    expect(err).toMatch(/^(attempt .+\n)*error: /);
  });
});

describe("hello-gateway route failure lines", () => {
  it("prints one attempt line per failed step, in order, before the error line", async () => {
    const fetchStub = forbidNetwork();
    const { code, out, err } = await runWith(["hi"], { CORE_ROUTE: "openai:gpt-4.1-mini,nope:x" });
    expect(code).toBe(1);
    expect(out).toBe("");
    const lines = err.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^attempt 1 openai:gpt-4\.1-mini: auth: .+/);
    expect(lines[1]).toMatch(/^attempt 2 nope:x: not_found: .+/);
    expect(lines[2]).toMatch(/^error: not_found: all 2 route steps failed$/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("numbers attempts from 1 and keeps a model id that contains colons", async () => {
    forbidNetwork();
    const { err } = await runWith(["hi"], { CORE_ROUTE: "nope:llama3.2:3b" });
    expect(err).toMatch(/^attempt 1 nope:llama3\.2:3b: not_found: .+\nerror: /);
  });

  it("shows the reason a provider rejected the request without leaking the key", async () => {
    const secret = "sk-attempt-line-key-789";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: `bad key ${secret}`, type: "auth" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { code, out, err } = await runWith(["hi"], {
      CORE_ROUTE: "openai:gpt-4.1-mini",
      CORE_OPENAI_API_KEY: secret,
    });
    expect(code).toBe(1);
    expect(err).toMatch(/^attempt 1 openai:gpt-4\.1-mini: auth: .+\nerror: auth: all 1 route steps failed\n$/);
    expect(out + err).not.toContain(secret);
  });

  it("prints no attempt lines when a later step succeeds", async () => {
    forbidNetwork();
    const { code, err } = await runWith(["hi"], { CORE_ROUTE: "nope:x,mock:echo" });
    expect(code).toBe(0);
    expect(err).not.toContain("attempt 1");
    expect(err).not.toContain("error:");
  });
});

describe("hello-gateway CORE_TIMEOUT_MS", () => {
  for (const value of ["abc", "0", "-5", "1.5"]) {
    it(`exits 2 with a clear error for ${JSON.stringify(value)} and calls no model`, async () => {
      const fetchStub = forbidNetwork();
      const { code, out, err } = await runWith(["hi"], {
        CORE_ROUTE: "openai:gpt-4.1-mini,mock:echo",
        CORE_OPENAI_API_KEY: "sk-timeout-test-key",
        CORE_TIMEOUT_MS: value,
      });
      expect(code).toBe(2);
      expect(out).toBe("");
      expect(err).toBe("error: bad_request: CORE_TIMEOUT_MS must be a positive integer\n");
      expect(fetchStub).not.toHaveBeenCalled();
    });
  }

  it("accepts a positive integer and answers normally", async () => {
    const { code, out, err } = await runWith(["hi"], { CORE_TIMEOUT_MS: "120000" });
    expect(code).toBe(0);
    expect(out).toBe("echo: hi\n");
    expect(err).toMatch(/^\[via mock:echo · \d+ ms · 1 attempt\(s\)\]\n$/);
  });

  it("reaches the router: a step slower than the value times out and the route falls back", async () => {
    const fetchStub = hangingNetwork();
    const { code, out, err } = await runWith(["hi"], {
      CORE_ROUTE: "openai:gpt-4.1-mini,mock:echo",
      CORE_OPENAI_API_KEY: "sk-timeout-test-key",
      CORE_TIMEOUT_MS: "50",
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
    expect(out).toBe("echo: hi\n");
    expect(err).toMatch(/^\[via mock:echo · \d+ ms · 2 attempt\(s\)\]\n$/);
  });

  it("applies the value to the step: the failure line names it", async () => {
    hangingNetwork();
    const { code, err } = await runWith(["hi"], {
      CORE_ROUTE: "openai:gpt-4.1-mini",
      CORE_OPENAI_API_KEY: "sk-timeout-test-key",
      CORE_TIMEOUT_MS: "50",
    });
    expect(code).toBe(1);
    expect(err).toMatch(/^attempt 1 openai:gpt-4\.1-mini: timeout: .*timed out after 50 ms\nerror: timeout: /);
  });
});
