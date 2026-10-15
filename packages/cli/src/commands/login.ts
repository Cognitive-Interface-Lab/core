import { parseArgs } from "node:util";
import { CoreError, type StoredCredential } from "@core/contracts";
import {
  MemorySecretStore,
  PersistentCredentialStore,
  signInCloudflare,
  signInOpenRouter,
  type OpenUrl,
} from "@core/credentials";
import { MemoryCredentialStore, PRESETS } from "@core/models";
import { loadConfig } from "../config.js";
import { envSource, makeProvider, openGateway } from "../setup.js";
import { UsageError, type Command, type Io } from "../run.js";

const VERIFY_TIMEOUT_MS = 15_000;
/** The same rule the saved sign-in enforces: the region goes into a hostname. */
const AWS_REGION = /^[a-z0-9-]+$/;

/** Trilix's public Cloudflare OAuth client (PKCE, no secret); core's terminal callback is registered on it. */
export const DEFAULT_CLOUDFLARE_OAUTH_CLIENT_ID = "f399a49cc3e2c96f6d1b06ef2b977c1b";

/** The page where each keyed provider creates an API key. */
export const KEY_PAGES: Record<string, string> = {
  openai: "https://platform.openai.com/api-keys",
  groq: "https://console.groq.com/keys",
  openrouter: "https://openrouter.ai/settings/keys",
  cloudflare: "https://dash.cloudflare.com/profile/api-tokens",
  vercel: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys",
  anthropic: "https://platform.claude.com/settings/keys",
  "anthropic-aws": "https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws",
};

const KEY_LABELS: Record<string, string> = {
  openai: "OpenAI",
  groq: "Groq",
  openrouter: "OpenRouter",
  cloudflare: "Cloudflare",
  vercel: "Vercel AI Gateway",
  anthropic: "Anthropic",
  "anthropic-aws": "Claude Platform on AWS",
};

const OPTIONS = {
  key: { type: "boolean" },
  browser: { type: "boolean" },
  "account-id": { type: "string" },
  "no-open": { type: "boolean" },
} as const;

export const loginCommand: Command = {
  summary: "sign in to a model provider and save the credentials",
  usage: `<provider> [--key] [--browser] [--account-id <id>] [--no-open]

providers:
  openrouter            browser sign-in (default), or --key to paste an API key
  cloudflare            browser sign-in (default), or --key to paste an API token and account ID
  openai, groq, vercel  paste an API key; core opens the page that creates one
  anthropic             paste an API key; core opens the page that creates one
  anthropic-aws         Claude Platform on AWS: asks for region, workspace ID and API key
  ollama                needs no sign-in

options:
  --key               paste an API key or token instead of signing in with the browser
  --browser           sign in with the browser (the default for openrouter and cloudflare)
  --account-id <id>   Cloudflare account ID (skips the question)
  --no-open           print the page's URL without opening the browser`,

  async run(args: string[], io: Io): Promise<number> {
    const { provider, flags } = parse(args);

    if (provider === "ollama") {
      io.stdout.write(`ollama needs no sign-in (it runs on this machine at ${PRESETS["ollama"]?.baseURL})\n`);
      return 0;
    }

    // Open the store first: a missing keychain should fail before the user has signed in, not after.
    const { store } = await openGateway(io, {});

    const interrupted = new AbortController();
    const unsubscribe = io.onInterrupt(() => interrupted.abort());
    try {
      const credential = await obtain(provider, flags, io, interrupted.signal);
      const modelCount = await verify(provider, credential, io, interrupted.signal);

      await store.save(provider, credential);
      io.stdout.write(
        modelCount === undefined
          ? `Signed in to ${provider}. Saved in ${store.location}.\n`
          : `Signed in to ${provider} (${modelCount} models available). Saved in ${store.location}.\n`,
      );
      const override = envSource(io.env, provider);
      if (override) io.stderr.write(`warning: ${override} is set and takes precedence over the saved sign-in\n`);
      return 0;
    } finally {
      unsubscribe();
    }
  },
};

type Flags = { key: boolean; browser: boolean; accountId: string | undefined; noOpen: boolean };

function parse(args: string[]): { provider: string; flags: Flags } {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
  const [provider, ...extra] = parsed.positionals;
  const valid = Object.keys(PRESETS).sort().join(", ");
  if (provider === undefined) throw new UsageError(`missing <provider>; choose one of: ${valid}`);
  if (extra.length > 0) throw new UsageError(`too many arguments: ${extra.join(" ")}`);
  if (!Object.hasOwn(PRESETS, provider)) throw new UsageError(`unknown provider "${provider}"; choose one of: ${valid}`);

  const flags: Flags = {
    key: parsed.values.key === true,
    browser: parsed.values.browser === true,
    accountId: parsed.values["account-id"],
    noOpen: parsed.values["no-open"] === true,
  };
  if (flags.key && flags.browser) throw new UsageError("--key and --browser cannot be used together");
  if (flags.accountId !== undefined && provider !== "cloudflare") {
    throw new UsageError("--account-id only applies to cloudflare");
  }
  if (flags.browser && provider !== "openrouter" && provider !== "cloudflare") {
    throw new UsageError(`${provider} has no browser sign-in; paste an API key instead`);
  }
  return { provider, flags };
}

async function obtain(provider: string, flags: Flags, io: Io, signal: AbortSignal): Promise<StoredCredential> {
  if (provider === "openrouter" && !flags.key) {
    return signInOpenRouter({ openUrl: opener(provider, flags, io), fetch: io.fetch, signal });
  }
  if (provider === "cloudflare" && !flags.key) {
    return browserCloudflare(flags, io, signal);
  }
  await showKeyPage(provider, flags, io);
  if (provider === "cloudflare") {
    const apiKey = nonEmpty(await io.prompt.secret("Cloudflare API token (Workers AI read + edit): "));
    const accountId = flags.accountId?.trim() || nonEmpty(await io.prompt.line("Cloudflare account ID: "));
    return { kind: "api-key", apiKey, accountId };
  }
  if (provider === "anthropic-aws") {
    const region = nonEmpty(await io.prompt.line("AWS region (for example us-west-2): "));
    if (!AWS_REGION.test(region)) throw new UsageError(`not an AWS region: ${region}`);
    const workspaceId = nonEmpty(await io.prompt.line("Claude workspace ID: "));
    const apiKey = nonEmpty(await io.prompt.secret("Claude Platform on AWS API key: "));
    return { kind: "api-key", apiKey, region, workspaceId };
  }
  const label = provider === "openrouter" ? "OpenRouter" : provider === "anthropic" ? "Anthropic" : provider;
  return { kind: "api-key", apiKey: nonEmpty(await io.prompt.secret(`${label} API key: `)) };
}

async function browserCloudflare(flags: Flags, io: Io, signal: AbortSignal): Promise<StoredCredential> {
  const clientId =
    io.env["CORE_CLOUDFLARE_OAUTH_CLIENT_ID"] ||
    (await loadConfig(io.configDir)).cloudflare?.oauthClientId ||
    DEFAULT_CLOUDFLARE_OAUTH_CLIENT_ID;
  const { credential, accounts } = await signInCloudflare({
    clientId,
    openUrl: opener("cloudflare", flags, io),
    fetch: io.fetch,
    signal,
  });
  if (credential.kind !== "oauth") throw new CoreError("unknown", "cloudflare: unexpected sign-in result");

  let accountId: string;
  if (flags.accountId !== undefined) {
    if (!accounts.some((account) => account.id === flags.accountId)) {
      const known = accounts.map((account) => `${account.name} (${account.id})`).join(", ") || "none";
      throw new CoreError("not_found", `account ${flags.accountId} is not one of your Cloudflare accounts: ${known}`);
    }
    accountId = flags.accountId;
  } else if (accounts.length === 0) {
    throw new CoreError("auth", "this Cloudflare sign-in has no accounts");
  } else if (accounts.length === 1) {
    accountId = (accounts[0] as { id: string }).id;
  } else {
    const index = await io.prompt.choose(
      "Which Cloudflare account?",
      accounts.map((account) => `${account.name} (${account.id})`),
    );
    const chosen = index === undefined ? undefined : accounts[index];
    if (!chosen) throw new UsageError("no account chosen; pass --account-id <id>");
    accountId = chosen.id;
  }
  return { ...credential, accountId };
}

/** Before asking for a key in a terminal: print, and open, the page that creates one. */
async function showKeyPage(provider: string, flags: Flags, io: Io): Promise<void> {
  const url = KEY_PAGES[provider];
  if (!io.interactive || url === undefined) return;
  io.stderr.write(`Create a ${KEY_LABELS[provider] ?? provider} API key on this page, then paste it below:\n${url}\n`);
  if (!flags.noOpen) await io.openUrl(url);
}

function opener(provider: string, flags: Flags, io: Io): OpenUrl {
  return async (url) => {
    io.stderr.write(`Opening your browser to sign in to ${provider}. If it does not open, visit:\n${url}\n`);
    if (!flags.noOpen) await io.openUrl(url);
  };
}

/**
 * Lists the provider's models with the new credentials, so a bad key is caught before it is saved.
 * Returns the model count, or `undefined` when the check could not be made (a warning is printed).
 */
async function verify(provider: string, credential: StoredCredential, io: Io, interrupt: AbortSignal): Promise<number | undefined> {
  // Reuse the store's own mapping from a saved record to provider credentials.
  const mapper = new PersistentCredentialStore({ secrets: new MemorySecretStore() });
  await mapper.save(provider, credential);
  const credentials = await mapper.get(provider);
  const probe = makeProvider(provider, new MemoryCredentialStore(credentials ? { [provider]: credentials } : {}), io);

  try {
    const models = await probe.listModels?.({ signal: AbortSignal.any([interrupt, AbortSignal.timeout(VERIFY_TIMEOUT_MS)]) });
    return models?.length;
  } catch (error) {
    if (!CoreError.is(error)) throw error;
    if (error.code === "auth" || error.code === "not_found" || error.code === "aborted") throw error;
    io.stderr.write(`warning: saved, but could not verify: ${error.code}: ${error.message}\n`);
    return undefined;
  }
}

function nonEmpty(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new UsageError("nothing entered");
  return trimmed;
}
