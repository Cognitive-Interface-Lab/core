import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CoreError } from "@core/contracts";

const DEFAULT_TIMEOUT_MS = 300_000;

export type CallbackServer = {
  /** `http://localhost:<port><path>` */
  readonly redirectUri: string;
  /** Resolves with the query parameters of the first request to the callback path. */
  wait(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<URLSearchParams>;
  close(): Promise<void>;
};

/**
 * A one-shot web server for the redirect at the end of a browser sign-in. It listens on `127.0.0.1`
 * only. The redirect URI says `localhost`, which browsers resolve to IPv4 when `::1` refuses.
 * `port` 0 or omitted picks any free port.
 */
export async function startCallbackServer(opts: { path: string; port?: number }): Promise<CallbackServer> {
  const { path } = opts;
  if (!path.startsWith("/")) throw new CoreError("bad_request", `callback path must start with "/": ${path}`);
  const requestedPort = opts.port ?? 0;

  let finish!: (params: URLSearchParams) => void;
  const received = new Promise<URLSearchParams>((resolve) => (finish = resolve));
  let completed = false;
  let closed = false;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== path || completed) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("Not found");
      return;
    }
    completed = true;
    const failed = url.searchParams.has("error");
    const message = failed
      ? "Sign-in failed. You can close this tab."
      : "Signed in. You can close this tab and return to the terminal.";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><title>core</title><p>${message}</p>`, () => {
      // Close first, so that when `wait` resolves the port is already free again.
      void close().then(() => finish(url.searchParams));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new CoreError("unavailable", `port ${requestedPort} is in use; close the program using it and try again`)
          : new CoreError("unavailable", `cannot start the sign-in receiver${error.code ? ` (${error.code})` : ""}`),
      );
    });
    server.listen(requestedPort, "127.0.0.1", resolve);
  });
  server.on("error", () => {});

  const port = (server.address() as AddressInfo).port;

  function close(): Promise<void> {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return {
    redirectUri: `http://localhost:${port}${path}`,
    close,
    async wait(waitOpts) {
      const timeoutMs = waitOpts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const signal = waitOpts?.signal;
      if (closed && !completed) throw new CoreError("aborted", "the sign-in receiver is closed");
      if (signal?.aborted) {
        await close();
        throw new CoreError("aborted", "sign-in was cancelled");
      }
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CoreError("timeout", `sign-in was not completed within ${describeMinutes(timeoutMs)}`)),
          timeoutMs,
        );
        onAbort = () => reject(new CoreError("aborted", "sign-in was cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([received, interrupted]);
      } catch (error) {
        await close();
        throw error;
      } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function describeMinutes(ms: number): string {
  const minutes = Math.round((ms / 60_000) * 10) / 10;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
