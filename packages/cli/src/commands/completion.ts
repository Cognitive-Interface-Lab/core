import { bashScript } from "../completion/bash.js";
import { completionSpec } from "../completion/spec.js";
import { UsageError, type Command, type Io } from "../run.js";

const SHELLS = ["bash"];

export const completionCommand: Command = {
  summary: "print a script that makes Tab complete core commands in your shell",
  usage: `bash

Install for bash (loaded on the first Tab; needs the bash-completion package):
  mkdir -p ~/.local/share/bash-completion/completions
  core completion bash > ~/.local/share/bash-completion/completions/core
Run it again after updating core.`,
  async run(args: string[], io: Io): Promise<number> {
    const [shell, ...extra] = args;
    if (shell === undefined) throw new UsageError(`missing the shell; supported: ${SHELLS.join(", ")}`);
    if (!SHELLS.includes(shell)) throw new UsageError(`unknown shell "${shell}"; supported: ${SHELLS.join(", ")}`);
    if (extra.length > 0) throw new UsageError("too many arguments");
    io.stdout.write(bashScript(completionSpec()));
    return 0;
  },
};
