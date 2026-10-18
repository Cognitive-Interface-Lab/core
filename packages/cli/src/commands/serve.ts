import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { CoreError } from "@core/contracts";
import { createPresetRegistry, MockProvider } from "@core/models";
import { createCoreHandler, localBridge, ServeTokens, type PairApprover } from "@core/server";
import { loadConfig, resolveRoute } from "../config.js";
import { openGateway } from "../setup.js";
import { UsageError, version, type Command, type Io } from "../run.js";

const DEFAULT_PORT = 8977;
const TOKEN_FILE = "serve-token";
const GRAPHS_FILE = "graphs.sqlite";

const OPTIONS = {
  port: { type: "string" },
} as const;

function parseServeArgs(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: false, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

/** A positive whole number of 1 to 65535 written in decimal digits only. */
function parsePort(value: string): number {
  const port = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`--port must be a whole number from 1 to 65535, got "${value}"`);
  }
  return port;
}

/**
 * The local token, made on first use: 32 random bytes, base64url. An existing file that other users
 * can read is refused, as FileSecretStore refuses its own file.
 */
async function readLocalToken(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Already there: read it below. Any other failure is reported without the path's contents.
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") throw new CoreError("unavailable", `${path}: cannot be written`);
  }
  if (process.platform !== "win32") {
    const { mode } = await stat(path);
    if ((mode & 0o077) !== 0) {
      throw new CoreError("auth", `${path} is readable by other users; run: chmod 600 ${path}`);
    }
  }
  const token = (await readFile(path, "utf8")).trim();
  if (token === "") throw new CoreError("auth", `${path} is empty; delete it and run core serve again`);
  return token;
}

/** Asks at the terminal whether the page may pair. Without a terminal nobody can answer, so it refuses. */
function approverFor(io: Io): PairApprover {
  return async ({ origin, code, name }, signal) => {
    if (!io.interactive) {
      io.stderr.write("pairing needs core serve running in a terminal\n");
      return false;
    }
    // prompt.line writes the question to stderr itself. The bridge's signal ends the question with
    // its pairing, so a stale question never answers for the next site.
    const answer = await io.prompt.line(
      `${origin} asks to use core on this machine${name !== undefined ? ` as "${name}"` : ""}. Check that it shows the code ${code}. Allow? [y/N] `,
      { signal },
    );
    if (signal.aborted) {
      io.stderr.write(`pairing request from ${origin} ended\n`);
      return false;
    }
    return answer !== undefined && ["y", "yes"].includes(answer.trim().toLowerCase());
  };
}

export const serveCommand: Command = {
  summary: "answer websites you pair and programs on this machine over HTTP",
  usage: `[--port <n>]

Serves core on 127.0.0.1 until Ctrl+C. A website reaches it once you pair it: the page shows a code,
and the prompt asks you to confirm that the code matches. Programs on this machine send the local
token from serve-token in the config directory as "Authorization: Bearer <token>". That file is
made on first use and must be readable by you only (mode 600), or serve refuses to start.

--port sets the port, 8977 by default. It must be a whole number from 1 to 65535, otherwise it is a
usage error (exit 2).`,
  async run(args: string[], io: Io): Promise<number> {
    const { values } = parseServeArgs(args);
    const port = values.port === undefined ? DEFAULT_PORT : parsePort(values.port);

    const config = await loadConfig(io.configDir);
    const tokenPath = join(io.configDir, TOKEN_FILE);
    const localToken = await readLocalToken(tokenPath);
    const gateway = await openGateway(io, config);
    const tokens = new ServeTokens(await io.openSecrets());
    const bridge = localBridge({ port, tokens, localToken, approve: approverFor(io) });

    // Nothing configured: requests must then name a route. A configured route that is bad fails startup.
    const configured = Boolean(io.env["CORE_ROUTE"]) || config.route !== undefined;
    const defaultRoute = configured ? resolveRoute(undefined, io.env, config) : undefined;

    // Loaded here, not at the top: node:sqlite warns that it is experimental as soon as it loads,
    // and every other command would print that warning.
    const { SqliteGraphStore } = await import("@core/graph-sqlite");
    const graphStore = SqliteGraphStore.open(join(io.configDir, GRAPHS_FILE));
    let unsubscribe: () => void = () => {};
    const interrupted = new Promise<void>((resolve) => {
      unsubscribe = io.onInterrupt(() => resolve());
    });

    const handler = createCoreHandler({
      mode: "local",
      version: version(),
      authenticate: bridge.authenticate,
      credentialsFor: () => gateway.credentials,
      registryFor: (credentials) =>
        createPresetRegistry(credentials, { fetch: io.fetch, providers: [new MockProvider({ id: "mock" })] }),
      fetch: io.fetch,
      ...(defaultRoute !== undefined && { defaultRoute }),
      ...(config.timeoutMs !== undefined && { defaultTimeoutMs: config.timeoutMs }),
      graph: {
        store: graphStore,
        access: {
          canRead: async () => true,
          canWrite: async () => true,
          created: async () => undefined,
          list: () => graphStore.listGraphs(),
        },
      },
      middleware: [bridge.middleware],
    });

    const server = await io.serve(handler, port).catch((error: unknown): never => {
      unsubscribe();
      graphStore.close();
      throw error;
    });

    try {
      const origins = await tokens.origins();
      io.stdout.write(`core serve: listening on ${server.url}\n`);
      io.stdout.write(`paired sites: ${origins.length > 0 ? origins.join(", ") : "none"}\n`);
      io.stdout.write(`programs on this machine: use the token in ${tokenPath}\n`);
      await interrupted;
      return 130;
    } finally {
      await server.close();
      graphStore.close();
      unsubscribe();
    }
  },
};
