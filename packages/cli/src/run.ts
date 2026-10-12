import { createRequire } from "node:module";
import { CoreError } from "@core/contracts";
import type { SecretStore } from "@core/credentials";
import { configCommand } from "./commands/config.js";
import { loginCommand } from "./commands/login.js";

/** Everything the commands touch in the outside world, so each can be tested with a fake. */
export type Io = {
  env: Record<string, string | undefined>;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  /** stdin is a TTY. */
  interactive: boolean;
  configDir: string;
  prompt: {
    /** `undefined` = end of input or Ctrl+C. */
    line(question: string): Promise<string | undefined>;
    /** Never echoes in a TTY; reads one line from piped stdin. */
    secret(question: string): Promise<string | undefined>;
    /** A numbered list; the answer is 0-based. */
    choose(question: string, options: string[]): Promise<number | undefined>;
  };
  /** The whole of stdin. */
  readAll(): Promise<string>;
  /** Best effort, never throws. */
  openUrl(url: string): Promise<void>;
  fetch: typeof fetch;
  /** Opened lazily, once. */
  openSecrets(): Promise<SecretStore>;
  /** Ctrl+C while a command runs; returns the unsubscribe function. */
  onInterrupt(handler: () => void): () => void;
};

export type Command = {
  summary: string;
  usage: string;
  run(args: string[], io: Io): Promise<number>;
};

/** A mistake in how the command was called: reported with the command's usage, exit code 2. */
export class UsageError extends Error {}

/**
 * Later slices add their commands here. The getters keep module cycles harmless: a command module
 * imports `UsageError` from this file, so an entry must not be read before both have loaded.
 */
export const commands: Record<string, Command> = {
  get config() {
    return configCommand;
  },
  get login() {
    return loginCommand;
  },
};

export async function run(argv: string[], io: Io): Promise<number> {
  // A leading "--" only marks the end of the launcher's own options (`pnpm start -- --help`); skip it.
  const [name, ...args] = argv[0] === "--" ? argv.slice(1) : argv;

  if (name === undefined || name === "--help" || name === "-h") {
    io.stdout.write(overallUsage());
    return 0;
  }
  if (name === "help") {
    const topic = args[0];
    if (topic === undefined) {
      io.stdout.write(overallUsage());
      return 0;
    }
    const command = lookup(topic);
    if (!command) {
      io.stderr.write(`error: unknown command "${topic}"\n\n${overallUsage()}`);
      return 2;
    }
    io.stdout.write(commandUsage(topic, command));
    return 0;
  }
  if (name === "--version") {
    io.stdout.write(`${version()}\n`);
    return 0;
  }

  const command = lookup(name);
  if (!command) {
    io.stderr.write(`error: unknown command "${name}"\n\n${overallUsage()}`);
    return 2;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    io.stdout.write(commandUsage(name, command));
    return 0;
  }

  try {
    return await command.run(args, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`error: ${error.message}\n\n${commandUsage(name, command)}`);
      return 2;
    }
    if (CoreError.is(error)) {
      io.stderr.write(`error: ${error.code}: ${error.message}\n`);
      return 1;
    }
    io.stderr.write(`error: ${error instanceof Error ? error.message : "unexpected failure"}\n`);
    return 1;
  }
}

function lookup(name: string): Command | undefined {
  return Object.hasOwn(commands, name) ? commands[name] : undefined;
}

function overallUsage(): string {
  const rows: [string, string][] = [
    ...Object.entries(commands)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, command]): [string, string] => [name, command.summary]),
    ["help [command]", "show this help, or a command's usage"],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, summary]) => `  ${label.padEnd(width)}  ${summary}`);
  return [
    "usage: core <command> [options]",
    "",
    "commands:",
    ...lines,
    "",
    "options:",
    "  --version   print the version",
    "  -h, --help  show help",
    "",
  ].join("\n");
}

function commandUsage(name: string, command: Command): string {
  return `usage: core ${name} ${command.usage}\n\n${command.summary}\n`.replace(/ \n/g, "\n");
}

function version(): string {
  const manifest = createRequire(import.meta.url)("../package.json") as { version: string };
  return manifest.version;
}
