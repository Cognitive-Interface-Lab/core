import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@core/models";
import { bashScript } from "../src/completion/bash.js";
import { completionSpec } from "../src/completion/spec.js";
import { commands } from "../src/run.js";

/** Major version of the `bash` on PATH, or 0 when there is none. */
function bashMajor(): number {
  const probe = spawnSync("bash", ["--norc", "--noprofile", "-c", 'echo "${BASH_VERSINFO[0]}"'], { encoding: "utf8" });
  return probe.status === 0 ? Number(probe.stdout.trim()) || 0 : 0;
}

const RUNNER = `
source "$SCRIPT"
core() {
  printf '%s\\n' "$@" > "$STUB_LOG"
  printf '%s\\n' ollama:llama3 ollama:qwen openrouter:
}
COMP_LINE="$LINE"
COMP_POINT=\${#COMP_LINE}
_core
for word in "\${COMPREPLY[@]}"; do printf '%s\\n' "$word"; done
`;

let dir = "";
let script = "";
let stubLog = "";

/** Completes `line` in bash with the stub `core`; returns the candidates, sorted, and the stub's arguments. */
function complete(line: string): { words: string[]; stub: string[] | undefined } {
  rmSync(stubLog, { force: true });
  const result = spawnSync("bash", ["--norc", "--noprofile", "-c", RUNNER], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], SCRIPT: script, STUB_LOG: stubLog, LINE: line },
  });
  expect(result.status, result.stderr).toBe(0);
  const words = result.stdout.split("\n").filter((word) => word !== "").sort();
  let stub: string[] | undefined;
  try {
    stub = readFileSync(stubLog, "utf8").split("\n").slice(0, -1);
  } catch {
    stub = undefined;
  }
  return { words, stub };
}

const sorted = (words: string[]) => [...words].sort();
const commandNames = () => sorted([...Object.keys(commands), "help"]);

describe.skipIf(bashMajor() < 4)("the bash completion script", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "core-completion-"));
    script = join(dir, "core.bash");
    stubLog = join(dir, "stub.log");
    writeFileSync(script, bashScript(completionSpec()));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("completes command names and global options", () => {
    const all = complete("core ").words;
    expect(all).toEqual(commandNames());
    expect(all).not.toContain("__complete");
    expect(complete("core lo").words).toEqual(["login", "logout"]);
    expect(complete("core -").words).toEqual(sorted(["--help", "-h", "--version"]));
  });

  it("completes the topic of help and the shell of completion", () => {
    expect(complete("core help ").words).toEqual(commandNames());
    expect(complete("core completion ").words).toEqual(["bash"]);
  });

  it("completes login's provider and options, but not an option's value", () => {
    expect(complete("core login ").words).toEqual(sorted(Object.keys(PRESETS)));
    expect(complete("core login --").words).toEqual(
      sorted(["--key", "--browser", "--account-id", "--no-open", "--help"]),
    );
    expect(complete("core login --account-id ").words).toEqual([]);
  });

  it("completes config actions and keys", () => {
    expect(complete("core config ").words).toEqual(sorted(["get", "set", "unset"]));
    expect(complete("core config set ").words).toEqual(sorted(["route", "timeout-ms", "cloudflare.oauth-client-id"]));
    expect(complete("core config set timeout-ms ").words).toEqual([]);
  });

  it("asks core for route candidates after config set route", () => {
    const { words, stub } = complete("core config set route ");
    expect(words).toEqual(sorted(["ollama:llama3", "ollama:qwen", "openrouter:"]));
    expect(stub).toEqual(["__complete", "route", ""]);
  });

  it("asks core for route candidates after --model, trimmed after the colon", () => {
    const { words, stub } = complete("core ask --model ollama:ll");
    expect(words).toEqual(["llama3"]);
    expect(stub).toEqual(["__complete", "route", "ollama:ll"]);
  });

  it("completes nothing where nothing applies", () => {
    expect(complete("core ask hello ").words).toEqual([]);
    expect(complete("core models ollama ").words).toEqual([]);
  });
});
