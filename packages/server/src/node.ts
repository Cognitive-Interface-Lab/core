import { createAdaptorServer } from "@hono/node-server";
import { CoreError } from "@core/contracts";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CoreHandler } from "./handler.js";

/** The only interface `serveLocal` listens on. Never 0.0.0.0 or `::`. */
const HOST = "127.0.0.1";

/**
 * Serves `handler` on 127.0.0.1 through Node's HTTP server. `port: 0` takes a free port. `close`
 * stops accepting connections and ends open ones, streams included, so it never hangs on them.
 */
export function serveLocal(opts: {
  handler: CoreHandler;
  port: number;
}): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createAdaptorServer({
      fetch: (request) => opts.handler.fetch(request),
      hostname: HOST,
      // A library must not replace the process's global Request and Response.
      overrideGlobalObjects: false,
    });
    if (!(server instanceof Server)) {
      reject(new Error("serveLocal requires an HTTP/1 server"));
      return;
    }

    server.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new CoreError("unavailable", `port ${opts.port} is in use`) : error);
    });

    server.listen(opts.port, HOST, () => {
      const address: AddressInfo | string | null = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("serveLocal got no TCP address"));
        return;
      }
      resolve({
        url: `http://${HOST}:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
