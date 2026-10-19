import { parseArgs } from "node:util";
import { ServeTokens } from "@core/server";
import { UsageError, type Command, type Io } from "../run.js";

function parseUnpairArgs(args: string[]) {
  try {
    return parseArgs({ args, options: {}, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

/** Checks that `args` is exactly one website and returns its origin: scheme, host and port, without a path. */
function originArgument(args: string[]): string {
  const { positionals } = parseUnpairArgs(args);
  const [arg, ...extra] = positionals;
  if (arg === undefined) throw new UsageError("missing <origin>");
  if (extra.length > 0) throw new UsageError(`too many arguments: ${extra.join(" ")}`);
  let origin: string;
  try {
    origin = new URL(arg).origin;
  } catch {
    throw new UsageError(`not a website origin: "${arg}"`);
  }
  // A URL with an opaque origin (file:, data:) names no website.
  if (origin === "null") throw new UsageError(`not a website origin: "${arg}"`);
  return origin;
}

export const unpairCommand: Command = {
  summary: "forget a website paired with core serve",
  usage: `<origin>

Forgets the token that pairs a website with core serve, for example https://example.com. The origin is
the scheme, host and port; any path is dropped. A running core serve refuses that site's next request.

Exit 1 when the origin was not paired.`,
  async run(args: string[], io: Io): Promise<number> {
    const origin = originArgument(args);
    const tokens = new ServeTokens(await io.openSecrets());
    if (await tokens.forget(origin)) {
      io.stdout.write(`forgot ${origin}\n`);
      return 0;
    }
    io.stderr.write(`not paired: ${origin}\n`);
    return 1;
  },
};
