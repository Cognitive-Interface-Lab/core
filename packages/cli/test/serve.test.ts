import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServeTokens } from "@core/server";
import { saveConfig } from "../src/config.js";
import { bashScript } from "../src/completion/bash.js";
import { completionSpec } from "../src/completion/spec.js";
import { run } from "../src/run.js";
import { cleanupFakeIo, fakeIo, untilAborted, type FakeIo, type FakeIoOptions, type Served } from "./fake-io.js";

const WAIT_MS = 2000;
const APP = "https://app.example";
const posix = process.platform !== "win32";

const started: FakeIo[] = [];

afterEach(() => {
  // A test that failed halfway must not leave a serve running.
  for (const fake of started.splice(0)) fake.interrupt();
  cleanupFakeIo();
});

/** `promise`, or a rejection after WAIT_MS, so a broken command fails the test instead of hanging it. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), WAIT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Running = { fake: FakeIo; served: Served; exit: Promise<number>; stop(): Promise<number> };

/** Starts `core serve` and waits until it has handed its handler to `io.serve`. */
async function start(fake: FakeIo, args: string[] = []): Promise<Running> {
  started.push(fake);
  const exit = run(["serve", ...args], fake.io);
  const early = exit.then((code): never => {
    throw new Error(`serve exited early with ${code}: ${fake.stderr()}`);
  });
  early.catch(() => undefined);
  const served = await within(Promise.race([fake.whenServed(), early]), "serve to start");
  // The startup lines follow once the server is up.
  await within(
    (async () => {
      while (!fake.stdout().includes("programs on this machine")) await new Promise((resolve) => setTimeout(resolve, 2));
    })(),
    "the startup output",
  );
  return {
    fake,
    served,
    exit,
    stop: async () => {
      fake.interrupt();
      return within(exit, "serve to exit");
    },
  };
}

/** Runs `core serve` to the end without waiting for it to start; for commands that must refuse. */
async function runToEnd(fake: FakeIo, args: string[]): Promise<number> {
  return within(run(["serve", ...args], fake.io), "serve to exit");
}

/** A second run on the same config directory and secret store as `first`. */
const again = (first: FakeIo, overrides: FakeIoOptions = {}) =>
  fakeIo({ configDir: first.io.configDir, secretStore: first.secrets, ...overrides });

const tokenPath = (fake: FakeIo) => join(fake.io.configDir, "serve-token");
const localToken = (fake: FakeIo) => readFileSync(tokenPath(fake), "utf8").trim();

type Call = { method?: string; origin?: string; token?: string; body?: unknown };

/** A request as a browser or program would send it, to the handler, with the Host that the bridge expects. */
function send(served: Served, path: string, call: Call = {}): Promise<Response> {
  const headers = new Headers({ host: `127.0.0.1:${served.port}` });
  if (call.origin !== undefined) headers.set("origin", call.origin);
  if (call.token !== undefined) headers.set("authorization", `Bearer ${call.token}`);
  if (call.body !== undefined) headers.set("content-type", "application/json");
  return served.handler.fetch(
    new Request(`http://127.0.0.1:${served.port}${path}`, {
      method: call.method ?? (call.body !== undefined ? "POST" : "GET"),
      headers,
      ...(call.body !== undefined && { body: JSON.stringify(call.body) }),
    }),
  );
}

const pair = (served: Served, body: unknown = { code: "ABC234" }, origin = APP) =>
  send(served, "/v1/pair", { origin, body });

describe("core serve", () => {
  it("prints the listening url, the paired sites and where the local token is", async () => {
    const fake = fakeIo();
    const running = await start(fake);

    expect(running.served.port).toBe(8977);
    expect(fake.stdout()).toBe(
      `core serve: listening on http://127.0.0.1:8977\npaired sites: none\nprograms on this machine: use the token in ${tokenPath(fake)}\n`,
    );
    expect(await running.stop()).toBe(130);

    const tokens = new ServeTokens(fake.secrets);
    await tokens.issue("https://b.example");
    await tokens.issue(APP);
    const second = again(fake);
    const next = await start(second);
    expect(second.stdout().split("\n")[1]).toBe("paired sites: https://app.example, https://b.example");
    await next.stop();
  });

  it("serves on the port given by --port, 1 and 65535 included", async () => {
    for (const port of ["1", "9123", "65535"]) {
      const fake = fakeIo();
      const running = await start(fake, ["--port", port]);
      expect(running.served.port).toBe(Number(port));
      expect(fake.stdout()).toContain(`listening on http://127.0.0.1:${port}\n`);
      // The bridge only accepts the Host of the port it was started with.
      expect((await send(running.served, "/v1/providers", { token: localToken(fake) })).status).toBe(200);
      const wrongHost = await running.served.handler.fetch(
        new Request(`http://127.0.0.1:${port}/v1/providers`, {
          headers: { host: "127.0.0.1:8977", authorization: `Bearer ${localToken(fake)}` },
        }),
      );
      expect(wrongHost.status).toBe(421);
      await running.stop();
    }
  });

  it("rejects a --port that is not a whole number from 1 to 65535 with exit 2", async () => {
    for (const port of ["0", "70000", "65536", "x", "-1", "80.5", "1e3", "0x50", " 80", ""]) {
      const fake = fakeIo();
      expect(await runToEnd(fake, ["--port", port]), `--port ${JSON.stringify(port)}`).toBe(2);
      expect(fake.stderr(), `--port ${JSON.stringify(port)}`).toContain("error: ");
      expect(fake.stderr()).toContain("--port");
      expect(fake.stderr()).toContain("usage: core serve [--port <n>]");
      expect(fake.stdout()).toBe("");
      expect(fake.served).toEqual([]);
    }
  });

  it("creates serve-token with 32 random bytes and reuses it on the next run", async () => {
    const fake = fakeIo();
    const first = await start(fake);
    const token = localToken(fake);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await first.stop();

    const second = again(fake);
    const next = await start(second);
    expect(localToken(second)).toBe(token);
    expect((await send(next.served, "/v1/providers", { token })).status).toBe(200);
    await next.stop();
  });

  it.skipIf(!posix)("creates serve-token readable by its owner only (mode 600)", async () => {
    const fake = fakeIo();
    const running = await start(fake);
    expect(statSync(tokenPath(fake)).mode & 0o777).toBe(0o600);
    await running.stop();
  });

  it.skipIf(!posix)("refuses a serve-token that other users can read, naming the fix", async () => {
    const fake = fakeIo();
    mkdirSync(fake.io.configDir, { recursive: true });
    writeFileSync(tokenPath(fake), "a-token-that-is-world-readable\n");
    chmodSync(tokenPath(fake), 0o644);

    expect(await runToEnd(fake, [])).toBe(1);
    const path = tokenPath(fake);
    expect(fake.stderr()).toBe(`error: auth: ${path} is readable by other users; run: chmod 600 ${path}\n`);
    expect(fake.stdout()).toBe("");
    expect(fake.served).toEqual([]);

    // The fix named in the message makes it start.
    chmodSync(path, 0o600);
    const fixed = again(fake);
    const running = await start(fixed);
    expect((await send(running.served, "/v1/providers", { token: "a-token-that-is-world-readable" })).status).toBe(200);
    await running.stop();
  });

  it("lists the providers for a request with no Origin and the token from serve-token", async () => {
    const fake = fakeIo();
    const running = await start(fake);
    const token = localToken(fake);

    const answer = await send(running.served, "/v1/providers", { token });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { providers: { id: string }[] };
    expect(body.providers.map((provider) => provider.id)).toContain("mock");

    // Without the token, or with another one, the same request is refused.
    expect((await send(running.served, "/v1/providers")).status).toBe(401);
    expect((await send(running.served, "/v1/providers", { token: `${token}x` })).status).toBe(401);
    await running.stop();
  });

  describe("pairing", () => {
    it("gives a token after a scripted y, asking exactly what the contract says", async () => {
      const fake = fakeIo({ interactive: true, answers: { line: ["y"] } });
      const running = await start(fake);

      const answer = await pair(running.served);
      expect(answer.status).toBe(200);
      const body = (await answer.json()) as { origin: string; token: string };
      expect(body.origin).toBe(APP);
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fake.asked).toEqual([
        "https://app.example asks to use core on this machine. Check that it shows the code ABC234. Allow? [y/N] ",
      ]);

      // The token is the site's own: it works with the Origin, and not as the local token.
      const providers = await send(running.served, "/v1/providers", { origin: APP, token: body.token });
      expect(providers.status).toBe(200);
      expect((await send(running.served, "/v1/providers", { token: body.token })).status).toBe(401);
      await running.stop();
    });

    it("names the site's own label in the question when the page sends one", async () => {
      const fake = fakeIo({ interactive: true, answers: { line: ["yes"] } });
      const running = await start(fake);

      const answer = await pair(running.served, { code: "XYZ789", name: "Notes" });
      expect(answer.status).toBe(200);
      expect(fake.asked).toEqual([
        'https://app.example asks to use core on this machine as "Notes". Check that it shows the code XYZ789. Allow? [y/N] ',
      ]);
      await running.stop();
    });

    it("answers 403 and issues no token after a scripted n", async () => {
      const fake = fakeIo({ interactive: true, answers: { line: ["n"] } });
      const running = await start(fake);

      expect((await pair(running.served)).status).toBe(403);
      expect(fake.asked).toHaveLength(1);
      expect(await new ServeTokens(fake.secrets).origins()).toEqual([]);
      await running.stop();
    });

    it("gives the prompt the bridge's signal, and when it aborts ends the question without a token", async () => {
      const fake = fakeIo({ interactive: true, answers: { line: [untilAborted, "y"] } });
      const running = await start(fake);
      const abort = new AbortController();

      const pending = running.served.handler.fetch(
        new Request(`http://127.0.0.1:${running.served.port}/v1/pair`, {
          method: "POST",
          headers: { host: `127.0.0.1:${running.served.port}`, origin: APP, "content-type": "application/json" },
          body: JSON.stringify({ code: "ABC234" }),
          signal: abort.signal,
        }),
      );
      await within(
        (async () => {
          while (fake.asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
        })(),
        "the pairing question",
      );
      const signal = fake.lineSignals[0];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      abort.abort();
      const answer = await within(pending, "the pairing to end");
      expect(answer.status).toBe(499);
      expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("aborted");
      expect(signal?.aborted).toBe(true);
      expect(fake.stderr()).toContain("pairing request from https://app.example ended");
      expect(await new ServeTokens(fake.secrets).origins()).toEqual([]);

      // The slot is free again: another site can pair with a scripted y.
      const next = await pair(running.served, { code: "ABC234" }, "https://other.example");
      expect(next.status).toBe(200);
      expect(await new ServeTokens(fake.secrets).origins()).toEqual(["https://other.example"]);
      await running.stop();
    });

    it("refuses without a terminal and says why", async () => {
      const fake = fakeIo({ interactive: false, answers: { line: ["y"] } });
      const running = await start(fake);

      expect((await pair(running.served)).status).toBe(403);
      expect(fake.stderr()).toContain("pairing needs core serve running in a terminal");
      // Nobody was asked, and even a scripted yes could not pair.
      expect(fake.asked).toEqual([]);
      expect(await new ServeTokens(fake.secrets).origins()).toEqual([]);
      await running.stop();
    });
  });

  it("uses the route in the config as the default of a chat request that names none", async () => {
    const fake = fakeIo();
    await saveConfig(fake.io.configDir, { route: ["mock:echo"] });
    const running = await start(fake);

    const answer = await send(running.served, "/v1/chat", {
      token: localToken(fake),
      body: { messages: [{ role: "user", content: "hello there" }] },
    });
    expect(answer.status).toBe(200);
    const result = (await answer.json()) as { ok: boolean; model: unknown; text: string };
    expect(result.ok).toBe(true);
    expect(result.model).toEqual({ provider: "mock", model: "echo" });
    expect(result.text).toContain("hello there");
    await running.stop();

    // Without a configured route the same request has no model to use.
    const bare = fakeIo();
    const bareRunning = await start(bare);
    const refused = await send(bareRunning.served, "/v1/chat", {
      token: localToken(bare),
      body: { messages: [{ role: "user", content: "hello there" }] },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    await bareRunning.stop();
  });

  it("lists in the next run a graph made in the one before", async () => {
    const fake = fakeIo();
    const first = await start(fake);
    const token = localToken(fake);

    const empty = await send(first.served, "/v1/graphs", { token });
    expect(((await empty.json()) as { graphs: string[] }).graphs).toEqual([]);
    const created = await send(first.served, "/v1/graphs", { token, body: {} });
    expect(created.status).toBe(200);
    const { state } = (await created.json()) as { state: { graphId: string } };
    expect(state.graphId).toBeTruthy();
    expect(await first.stop()).toBe(130);

    const second = again(fake);
    const next = await start(second);
    const listed = await send(next.served, "/v1/graphs", { token });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { graphs: string[] }).graphs).toEqual([state.graphId]);
    await next.stop();
  });

  describe("unpair", () => {
    it("forgets a site, so the next request with its token is refused", async () => {
      const fake = fakeIo({ interactive: true, answers: { line: ["y"] } });
      const running = await start(fake);
      const { token } = (await (await pair(running.served)).json()) as { token: string };
      expect((await send(running.served, "/v1/providers", { origin: APP, token })).status).toBe(200);

      // Another process on the same secret store, as `core unpair` is while `core serve` runs.
      const other = again(fake);
      expect(await run(["unpair", APP], other.io)).toBe(0);
      expect(other.stdout()).toBe("forgot https://app.example\n");
      expect(other.stderr()).toBe("");

      expect((await send(running.served, "/v1/providers", { origin: APP, token })).status).toBe(403);
      expect(await new ServeTokens(fake.secrets).origins()).toEqual([]);
      await running.stop();
    });

    it("drops the path of the origin it is given", async () => {
      const fake = fakeIo();
      await new ServeTokens(fake.secrets).issue(APP);
      expect(await run(["unpair", "https://app.example/some/page?x=1"], fake.io)).toBe(0);
      expect(fake.stdout()).toBe("forgot https://app.example\n");
      expect(await new ServeTokens(fake.secrets).origins()).toEqual([]);
    });

    it("exits 2 for something that is not an origin and 1 for one that is not paired", async () => {
      const bad = fakeIo();
      expect(await run(["unpair", "not-a-url"], bad.io)).toBe(2);
      expect(bad.stderr()).toContain('error: not a website origin: "not-a-url"');
      expect(bad.stdout()).toBe("");

      const unknown = fakeIo();
      await new ServeTokens(unknown.secrets).issue(APP);
      expect(await run(["unpair", "https://unknown.example"], unknown.io)).toBe(1);
      expect(unknown.stderr()).toBe("not paired: https://unknown.example\n");
      expect(unknown.stdout()).toBe("");
      // The site that is paired stays paired.
      expect(await new ServeTokens(unknown.secrets).origins()).toEqual([APP]);
    });
  });

  it("closes the server once on Ctrl+C and exits 130", async () => {
    const fake = fakeIo();
    const running = await start(fake);
    expect(running.served.closes).toBe(0);
    expect(fake.interruptHandlers()).toBe(1);

    expect(await running.stop()).toBe(130);
    expect(running.served.closes).toBe(1);
    expect(fake.interruptHandlers()).toBe(0);
    expect(fake.interrupt()).toBe(false);
  });

  it("does not close again when a second interrupt arrives while closing, and still exits 130", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closes = 0;
    const fake = fakeIo({
      serve: async (_handler, port) => ({
        url: `http://127.0.0.1:${port}`,
        close: async () => {
          closes += 1;
          await gate;
        },
      }),
    });
    started.push(fake);
    const exit = run(["serve"], fake.io);
    const wait = (until: () => boolean, what: string) =>
      within(
        (async () => {
          while (!until()) await new Promise((resolve) => setTimeout(resolve, 2));
        })(),
        what,
      );
    await wait(() => fake.stdout().includes("programs on this machine"), "the startup output");

    expect(fake.interrupt()).toBe(true);
    await wait(() => closes === 1, "close to be called");
    // close() is still pending on the gate: the command has not returned and is still listening for Ctrl+C.
    expect(fake.interruptHandlers()).toBe(1);
    expect(fake.interrupt()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closes).toBe(1);

    release();
    expect(await within(exit, "serve to exit")).toBe(130);
    expect(closes).toBe(1);
    expect(fake.interruptHandlers()).toBe(0);
  });

  describe("help and completion", () => {
    it("prints the usage for help serve", async () => {
      const fake = fakeIo();
      expect(await run(["help", "serve"], fake.io)).toBe(0);
      expect(fake.stdout()).toContain("usage: core serve [--port <n>]");
      expect(fake.stderr()).toBe("");
    });

    it("lists --port as an option that takes a value", () => {
      const spec = completionSpec().commands["serve"];
      expect(spec?.options).toContain("--port");
      expect(spec?.valueOptions).toEqual(["--port"]);
    });

    /** Major version of the `bash` on PATH, or 0 when there is none. */
    const bashMajor = (() => {
      const probe = spawnSync("bash", ["--norc", "--noprofile", "-c", 'echo "${BASH_VERSINFO[0]}"'], { encoding: "utf8" });
      return probe.status === 0 ? Number(probe.stdout.trim()) || 0 : 0;
    })();

    it.skipIf(bashMajor < 4)("offers --port after `core serve -` when Tab is pressed in bash", () => {
      const dir = mkdtempSync(join(tmpdir(), "core-serve-completion-"));
      try {
        const script = join(dir, "core.bash");
        writeFileSync(script, bashScript(completionSpec()));
        const runner = `
source "$SCRIPT"
core() { :; }
COMP_LINE="$LINE"
COMP_POINT=\${#COMP_LINE}
_core
for word in "\${COMPREPLY[@]}"; do printf '%s\\n' "$word"; done
`;
        const result = spawnSync("bash", ["--norc", "--noprofile", "-c", runner], {
          encoding: "utf8",
          env: { PATH: process.env["PATH"], SCRIPT: script, LINE: "core serve -" },
        });
        expect(result.status, result.stderr).toBe(0);
        const words = result.stdout.split("\n").filter((word) => word !== "");
        expect(words).toContain("--port");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
