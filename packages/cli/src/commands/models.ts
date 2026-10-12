import { CoreError } from "@core/contracts";
import { openGateway, type Gateway } from "../setup.js";
import { UsageError, type Command, type Io } from "../run.js";
import { providerArgument } from "./account.js";

const LIST_TIMEOUT_MS = 15_000;

type Result = { provider: string; models?: string[]; error?: CoreError };

export const modelsCommand: Command = {
  summary: "list the models a provider offers, as provider:model lines",
  usage: `[provider]

With a provider, lists its models. Without one, lists every provider you are signed in to, plus ollama.
The output can be pasted into: core config set route <provider:model,...>`,
  async run(args: string[], io: Io): Promise<number> {
    const only = args.length > 0 ? providerArgument(args) : undefined;
    const gateway = await openGateway(io, {});

    const interrupted = new AbortController();
    const unsubscribe = io.onInterrupt(() => interrupted.abort());
    try {
      const signal = AbortSignal.any([interrupted.signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]);
      if (only !== undefined) {
        for (const model of await list(gateway, only, signal)) io.stdout.write(`${only}:${model}\n`);
        return 0;
      }

      const candidates: string[] = [];
      const failures: Map<string, CoreError> = new Map();
      for (const provider of gateway.providers) {
        if (provider === "ollama") {
          candidates.push(provider);
          continue;
        }
        try {
          if ((await gateway.credentials.get(provider)) !== undefined) candidates.push(provider);
        } catch (error) {
          // Credentials exist but cannot be used (for example an expired sign-in that cannot renew).
          candidates.push(provider);
          failures.set(provider, asCoreError(error));
        }
      }
      const results = await Promise.all(
        candidates.map(async (provider): Promise<Result> => {
          const known = failures.get(provider);
          if (known) return { provider, error: known };
          try {
            return { provider, models: await list(gateway, provider, signal) };
          } catch (error) {
            return { provider, error: asCoreError(error) };
          }
        }),
      );

      let failed = 0;
      for (const result of results) {
        if (result.error) {
          failed += 1;
          io.stderr.write(`${result.provider}: ${result.error.code}: ${stripProvider(result.error.message, result.provider)}\n`);
        } else {
          for (const model of result.models ?? []) io.stdout.write(`${result.provider}:${model}\n`);
        }
      }
      return failed === results.length ? 1 : 0;
    } finally {
      unsubscribe();
    }
  },
};

async function list(gateway: Gateway, provider: string, signal: AbortSignal): Promise<string[]> {
  const found = gateway.registry.get(provider);
  if (!found.listModels) throw new UsageError(`${provider} cannot list its models`);
  return found.listModels({ signal });
}

function asCoreError(error: unknown): CoreError {
  return CoreError.is(error) ? error : new CoreError("unknown", error instanceof Error ? error.message : "unexpected failure");
}

function stripProvider(message: string, provider: string): string {
  return message.startsWith(`${provider}: `) ? message.slice(provider.length + 2) : message;
}
