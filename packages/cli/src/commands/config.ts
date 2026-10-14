import { CoreError, parseModelRef } from "@core/contracts";
import { loadConfig, saveConfig, splitRoute, type Config } from "../config.js";
import { UsageError, type Command, type Io } from "../run.js";

const KEYS = ["route", "timeout-ms", "cloudflare.oauth-client-id"] as const;
type Key = (typeof KEYS)[number];

export const configCommand: Command = {
  summary: "show or change saved settings",
  usage: `[get <key> | set <key> <value> | unset <key>]

keys:
  route                       models to try in order, comma-separated provider:model
  timeout-ms                  per-attempt timeout in milliseconds
  cloudflare.oauth-client-id  OAuth client ID for "core login cloudflare --browser" (public)`,
  async run(args: string[], io: Io): Promise<number> {
    const [action, key, value, ...extra] = args;

    if (action === undefined) {
      io.stdout.write(`${JSON.stringify(await loadConfig(io.configDir), null, 2)}\n`);
      return 0;
    }

    switch (action) {
      case "get": {
        requireArgs(action, [key], value === undefined && extra.length === 0);
        const current = read(await loadConfig(io.configDir), asKey(key));
        if (current === undefined) return 1;
        io.stdout.write(`${current}\n`);
        return 0;
      }
      case "set": {
        requireArgs(action, [key, value], extra.length === 0);
        const name = asKey(key);
        const updated = write(await loadConfig(io.configDir), name, value as string);
        await saveConfig(io.configDir, updated);
        io.stdout.write(`${name} = ${read(updated, name)}\n`);
        return 0;
      }
      case "unset": {
        requireArgs(action, [key], value === undefined && extra.length === 0);
        const name = asKey(key);
        await saveConfig(io.configDir, remove(await loadConfig(io.configDir), name));
        io.stdout.write(`${name} unset\n`);
        return 0;
      }
      default:
        throw new UsageError(`unknown action "${action}"`);
    }
  },
};

function requireArgs(action: string, required: (string | undefined)[], noExtra: boolean): void {
  if (required.some((arg) => arg === undefined)) throw new UsageError(`"config ${action}" is missing an argument`);
  if (!noExtra) throw new UsageError(`"config ${action}" has too many arguments`);
}

function asKey(key: string | undefined): Key {
  if (key !== undefined && (KEYS as readonly string[]).includes(key)) return key as Key;
  throw new UsageError(`unknown key "${key ?? ""}"; keys are ${KEYS.join(", ")}`);
}

function read(config: Config, key: Key): string | undefined {
  switch (key) {
    case "route":
      return config.route?.join(",");
    case "timeout-ms":
      return config.timeoutMs === undefined ? undefined : String(config.timeoutMs);
    case "cloudflare.oauth-client-id":
      return config.cloudflare?.oauthClientId;
  }
}

function write(config: Config, key: Key, value: string): Config {
  switch (key) {
    case "route": {
      const entries = splitRoute(value);
      if (entries.length === 0) throw new UsageError("route must list at least one provider:model");
      for (const entry of entries) {
        try {
          parseModelRef(entry);
        } catch (error) {
          throw new UsageError(CoreError.is(error) ? error.message : `invalid model ref "${entry}"`);
        }
      }
      return { ...config, route: entries };
    }
    case "timeout-ms": {
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
        throw new UsageError("timeout-ms must be a positive whole number of milliseconds");
      }
      return { ...config, timeoutMs: number };
    }
    case "cloudflare.oauth-client-id": {
      const id = value.trim();
      if (id.length === 0) throw new UsageError("cloudflare.oauth-client-id must not be empty");
      return { ...config, cloudflare: { ...config.cloudflare, oauthClientId: id } };
    }
  }
}

function remove(config: Config, key: Key): Config {
  const next: Config = { ...config };
  switch (key) {
    case "route":
      delete next.route;
      break;
    case "timeout-ms":
      delete next.timeoutMs;
      break;
    case "cloudflare.oauth-client-id":
      delete next.cloudflare;
      break;
  }
  return next;
}
