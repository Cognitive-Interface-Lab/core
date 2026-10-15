import { PRESETS } from "@core/models";
import { KEYS } from "../commands/config.js";
import { commands } from "../run.js";

/** What a command's first positional argument is, for completion. */
export type Positional = "command" | "provider" | "config" | "shell";

export type CommandSpec = {
  /** Every `--name` in the first line of the command's usage (its synopsis), in order, then "--help". No duplicates. */
  options: string[];
  /** The members of `options` that the synopsis shows with a value: `--name <...>`. */
  valueOptions: string[];
  /** What the first positional argument is; absent when it takes nothing worth completing. */
  positional?: Positional;
};

/** Everything Tab can complete, derived from the command registry, the usage texts and the presets. */
export type CompletionSpec = {
  /** Every entry of `commands` (run.ts) plus "help", keyed by name, keys sorted. */
  commands: Record<string, CommandSpec>;
  globalOptions: string[];
  providers: string[];
  configActions: string[];
  configKeys: string[];
  shells: string[];
};

const POSITIONALS: Record<string, Positional> = {
  login: "provider",
  logout: "provider",
  models: "provider",
  config: "config",
  completion: "shell",
};

export function completionSpec(): CompletionSpec {
  // Read the registry here, not at module load: run.ts imports this module indirectly.
  const specs: Record<string, CommandSpec> = {
    help: { options: [], valueOptions: [], positional: "command" },
  };
  for (const [name, command] of Object.entries(commands)) {
    specs[name] = commandSpec(name, command.usage);
  }
  const sorted: Record<string, CommandSpec> = {};
  for (const name of Object.keys(specs).sort()) sorted[name] = specs[name] as CommandSpec;

  return {
    commands: sorted,
    globalOptions: ["--help", "-h", "--version"],
    providers: Object.keys(PRESETS).sort(),
    configActions: ["get", "set", "unset"],
    configKeys: [...KEYS],
    shells: ["bash"],
  };
}

function commandSpec(name: string, usage: string): CommandSpec {
  // Only the synopsis counts: later lines may mention other commands' options.
  const synopsis = usage.split("\n", 1)[0] ?? "";
  const options: string[] = [];
  const valueOptions: string[] = [];
  for (const match of synopsis.matchAll(/(--[A-Za-z0-9][\w-]*)( <)?/g)) {
    const option = match[1] as string;
    if (!options.includes(option)) options.push(option);
    if (match[2] !== undefined && !valueOptions.includes(option)) valueOptions.push(option);
  }
  if (!options.includes("--help")) options.push("--help");
  const positional = POSITIONALS[name];
  return { options, valueOptions, ...(positional !== undefined && { positional }) };
}
