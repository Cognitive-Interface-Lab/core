import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CoreError } from "@core/contracts";
import { createPkce, randomState, startCallbackServer, type CallbackServer } from "../src/index.js";

const opened: CallbackServer[] = [];

async function start(opts: { path?: string; port?: number } = {}): Promise<CallbackServer> {
  const server = await startCallbackServer({ path: opts.path ?? "/callback", ...(opts.port !== undefined ? { port: opts.port } : {}) });
  opened.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((server) => server.close()));
});

/** The receiver listens on 127.0.0.1 and advertises localhost; tests talk to it directly. */
const loopbackUrl = (server: CallbackServer, suffix = "") => server.redirectUri.replace("localhost", "127.0.0.1") + suffix;
const portOf = (server: CallbackServer) => Number(new URL(server.redirectUri).port);

async function caught(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    expect(CoreError.is(error)).toBe(true);
    return error as CoreError;
  }
  throw new Error("expected the promise to reject");
}

async function refuses(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
}

describe("createPkce", () => {
  it("makes the challenge the base64url SHA-256 of the verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("uses 32 random bytes, base64url", () => {
    const { verifier } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(verifier, "base64url")).toHaveLength(32);
  });

  it("gives a different pair every time", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("randomState", () => {
  it("is 32 random bytes, base64url, and differs every time", () => {
    const state = randomState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomState()).not.toBe(state);
  });
});

describe("startCallbackServer", () => {
  it("advertises http://localhost:<port><path> on a free port", async () => {
    const server = await start({ path: "/oauth/callback" });
    expect(server.redirectUri).toMatch(/^http:\/\/localhost:\d+\/oauth\/callback$/);
    expect(portOf(server)).toBeGreaterThan(0);
  });

  it("treats port 0 like an omitted port", async () => {
    const server = await start({ port: 0 });
    expect(portOf(server)).toBeGreaterThan(0);
  });

  it("gives different servers different ports", async () => {
    const [a, b] = await Promise.all([start(), start()]);
    expect(portOf(a)).not.toBe(portOf(b));
  });

  it("rejects a path that does not start with a slash", async () => {
    expect((await caught(startCallbackServer({ path: "callback" }))).code).toBe("bad_request");
  });

  it("answers the callback with 200 HTML and resolves its query parameters", async () => {
    const server = await start();
    const waiting = server.wait({ timeoutMs: 5_000 });
    const response = await fetch(loopbackUrl(server, "?code=abc&state=xyz"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Signed in. You can close this tab and return to the terminal.");

    const params = await waiting;
    expect(params.get("code")).toBe("abc");
    expect(params.get("state")).toBe("xyz");
  });

  it("shows the failure page when the callback carries an error", async () => {
    const server = await start();
    const waiting = server.wait({ timeoutMs: 5_000 });
    const response = await fetch(loopbackUrl(server, "?error=access_denied&error_description=No"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sign-in failed. You can close this tab.");
    expect(html).not.toContain("Signed in.");
    const params = await waiting;
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("error_description")).toBe("No");
  });

  it("keeps the reply when it arrives before wait is called", async () => {
    const server = await start();
    const response = await fetch(loopbackUrl(server, "?code=early"));
    expect(response.status).toBe(200);
    expect((await server.wait({ timeoutMs: 5_000 })).get("code")).toBe("early");
  });

  it("closes the server once the callback has been served", async () => {
    const server = await start();
    const waiting = server.wait({ timeoutMs: 5_000 });
    await (await fetch(loopbackUrl(server, "?code=abc"))).text();
    await waiting;
    expect(await refuses(loopbackUrl(server))).toBe(true);
  });

  it("answers any other path with 404 and keeps waiting", async () => {
    const server = await start({ path: "/callback" });
    const waiting = server.wait({ timeoutMs: 5_000 });
    const other = await fetch(loopbackUrl(server).replace("/callback", "/elsewhere?code=nope"));
    expect(other.status).toBe(404);
    expect((await fetch(loopbackUrl(server).replace("/callback", "/favicon.ico"))).status).toBe(404);

    let settled = false;
    void waiting.finally(() => (settled = true)).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    expect((await fetch(loopbackUrl(server, "?code=real"))).status).toBe(200);
    expect((await waiting).get("code")).toBe("real");
  });

  it("rejects with timeout, naming the minutes, and closes the server", async () => {
    const server = await start();
    const error = await caught(server.wait({ timeoutMs: 30 }));
    expect(error.code).toBe("timeout");
    expect(error.message).toMatch(/^sign-in was not completed within .* minutes?$/);
    expect(await refuses(loopbackUrl(server))).toBe(true);
  });

  it("rejects with aborted when the signal fires, and closes the server", async () => {
    const server = await start();
    const controller = new AbortController();
    const waiting = server.wait({ signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();
    expect((await caught(waiting)).code).toBe("aborted");
    expect(await refuses(loopbackUrl(server))).toBe(true);
  });

  it("rejects with aborted when the signal is already aborted", async () => {
    const server = await start();
    const error = await caught(server.wait({ signal: AbortSignal.abort(), timeoutMs: 5_000 }));
    expect(error.code).toBe("aborted");
    expect(await refuses(loopbackUrl(server))).toBe(true);
  });

  it("rejects wait on a server that was closed without a reply", async () => {
    const server = await start();
    await server.close();
    expect((await caught(server.wait({ timeoutMs: 5_000 }))).code).toBe("aborted");
  });

  it("fails with unavailable when the port is in use", async () => {
    const first = await start();
    const port = portOf(first);
    const error = await caught(startCallbackServer({ path: "/callback", port }));
    expect(error.code).toBe("unavailable");
    expect(error.message).toBe(`port ${port} is in use; close the program using it and try again`);
    // The first server is unaffected.
    const waiting = first.wait({ timeoutMs: 5_000 });
    await (await fetch(loopbackUrl(first, "?code=still-works"))).text();
    expect((await waiting).get("code")).toBe("still-works");
  });

  it("can be started again on the port once it has closed", async () => {
    const first = await start();
    const port = portOf(first);
    await first.close();
    const second = await start({ port });
    expect(portOf(second)).toBe(port);
  });

  it("closes more than once without error", async () => {
    const server = await start();
    await server.close();
    await server.close();
    expect(await refuses(loopbackUrl(server))).toBe(true);
  });
});
