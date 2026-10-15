import { PRESETS } from "@core/models";
import { loadConfig, splitRoute } from "../config.js";
import { envSource, openGateway } from "../setup.js";
import { UsageError, type Command, type Io } from "../run.js";

/** Checks that `args` is exactly one known provider id and returns it. */
export function providerArgument(args: string[]): string {
  const valid = Object.keys(PRESETS).sort().join(", ");
  const [provider, ...extra] = args;
  if (provider === undefined) throw new UsageError(`missing <provider>; choose one of: ${valid}`);
  if (extra.length > 0) throw new UsageError(`too many arguments: ${extra.join(" ")}`);
  if (!Object.hasOwn(PRESETS, provider)) throw new UsageError(`unknown provider "${provider}"; choose one of: ${valid}`);
  return provider;
}

export const logoutCommand: Command = {
  summary: "remove the saved sign-in for a provider",
  usage: "<provider>",
  async run(args: string[], io: Io): Promise<number> {
    const provider = providerArgument(args);
    const { store } = await openGateway(io, {});

    // An unreadable record must still be removable, so a failed read only means "kind unknown".
    const kind = await store.read(provider).then(
      (record) => record?.kind,
      () => undefined,
    );
    if (!(await store.remove(provider))) {
      io.stdout.write(`Not signed in to ${provider}.\n`);
      return 0;
    }
    io.stdout.write(`Signed out of ${provider}.\n`);
    if (kind === "oauth") {
      io.stdout.write(
        "The grant stays on your Cloudflare account; remove it in the Cloudflare dashboard if you no longer want it.\n",
      );
    }
    return 0;
  },
};

export const statusCommand: Command = {
  summary: "show where each provider's credentials come from",
  usage: "",
  async run(args: string[], io: Io): Promise<number> {
    if (args.length > 0) throw new UsageError(`unexpected argument: ${args[0]}`);
    const config = await loadConfig(io.configDir);
    const { store, providers } = await openGateway(io, config);

    const saved = new Map((await store.list()).map((summary) => [summary.providerId, summary]));
    const rows: [string, string][] = [];
    for (const provider of providers) {
      rows.push([provider, await describe(provider, saved.get(provider), store, io)]);
    }
    const width = Math.max(...rows.map(([name]) => name.length));
    for (const [name, state] of rows) io.stdout.write(`${name.padEnd(width)}  ${state}\n`);

    const route = io.env["CORE_ROUTE"] || config.route?.join(",");
    io.stdout.write(`\nCredentials: ${store.location}\n`);
    io.stdout.write(
      route ? `Models: ${splitRoute(route).join(", ")}\n` : "Models: not set (core config set route ...)\n",
    );
    return 0;
  },
};

async function describe(
  provider: string,
  summary:
    | {
        kind: "api-key" | "oauth";
        accountId?: string | undefined;
        region?: string | undefined;
        workspaceId?: string | undefined;
        expiresAt?: number | undefined;
      }
    | undefined,
  store: { read(providerId: string): Promise<{ kind: string; refreshToken?: string } | undefined> },
  io: Io,
): Promise<string> {
  const variable = envSource(io.env, provider);
  if (variable) return `from ${variable}`;

  if (summary?.kind === "api-key") {
    const parts = [
      "key",
      summary.accountId ? `account ${summary.accountId}` : undefined,
      summary.workspaceId ? `workspace ${summary.workspaceId}` : undefined,
      summary.region ? `region ${summary.region}` : undefined,
    ];
    return `signed in (${parts.filter(Boolean).join(", ")})`;
  }
  if (summary?.kind === "oauth") {
    const account = summary.accountId ? `account ${summary.accountId}` : undefined;
    // Only the presence of a refresh token is looked at; its value is never kept or shown.
    const renews = Boolean((await store.read(provider))?.refreshToken);
    if (renews) return `signed in (${["browser", account, "renews automatically"].filter(Boolean).join(", ")})`;
    const remainingMs = (summary.expiresAt ?? 0) - Date.now();
    if (remainingMs <= 0) return "sign-in expired";
    const minutes = Math.ceil(remainingMs / 60_000);
    return `signed in (${["browser", account, `expires in ${minutes} min`].filter(Boolean).join(", ")})`;
  }
  if (provider === "ollama") return `no sign-in needed (${PRESETS["ollama"]?.baseURL})`;
  return "not signed in";
}
