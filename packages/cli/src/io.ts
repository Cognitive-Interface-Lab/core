import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { CoreError } from "@core/contracts";
import { openSecretStore, type SecretStore } from "@core/credentials";
import type { Io } from "./run.js";

type Env = Record<string, string | undefined>;

/** `$CORE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/core`, else `%APPDATA%\core` on Windows, else `~/.config/core`. */
export function defaultConfigDir(env: Env, platform: NodeJS.Platform, home: string): string {
  const path = platform === "win32" ? win32 : posix;
  if (env["CORE_CONFIG_DIR"]) return env["CORE_CONFIG_DIR"];
  if (env["XDG_CONFIG_HOME"]) return path.join(env["XDG_CONFIG_HOME"], "core");
  if (platform === "win32" && env["APPDATA"]) return path.join(env["APPDATA"], "core");
  return path.join(home, ".config", "core");
}

export function createNodeIo(): Io {
  const env: Env = process.env;
  const interactive = Boolean(process.stdin.isTTY);
  const configDir = defaultConfigDir(env, process.platform, homedir());
  const stderr = process.stderr;

  // Piped input is read as one ordered stream of lines, so answers are not lost between questions.
  let piped: { rl: Interface; lines: AsyncIterator<string> } | undefined;
  const pipedLines = () => {
    if (!piped) {
      const rl = createInterface({ input: process.stdin, terminal: false });
      piped = { rl, lines: rl[Symbol.asyncIterator]() };
    }
    return piped.lines;
  };

  async function line(question: string): Promise<string | undefined> {
    stderr.write(question);
    if (!interactive) {
      const next = await pipedLines().next();
      if (!next.done) stderr.write("\n");
      return next.done ? undefined : next.value;
    }
    const rl = createInterface({ input: process.stdin, output: stderr, terminal: true });
    try {
      return await new Promise<string | undefined>((resolve) => {
        rl.once("close", () => resolve(undefined));
        rl.once("SIGINT", () => rl.close());
        // The question was already written above; readline is only needed for line editing.
        rl.question("", (answer) => resolve(answer));
      });
    } finally {
      rl.close();
    }
  }

  function secret(question: string): Promise<string | undefined> {
    if (!interactive) return line(question);
    return new Promise((resolve) => {
      const stdin = process.stdin;
      let value = "";
      stderr.write(question);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const finish = (result: string | undefined) => {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        stderr.write("\n");
        resolve(result);
      };
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === "\r" || char === "\n") return finish(value);
          if (char === "\u0003" || char === "\u0004") return finish(undefined);
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else if (char >= " ") value += char;
        }
      };
      stdin.on("data", onData);
    });
  }

  async function choose(question: string, options: string[]): Promise<number | undefined> {
    stderr.write(`${question}\n`);
    options.forEach((option, index) => stderr.write(`  ${index + 1}) ${option}\n`));
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await line(`Enter 1-${options.length}: `);
      if (answer === undefined) return undefined;
      const number = Number(answer.trim());
      if (Number.isInteger(number) && number >= 1 && number <= options.length) return number - 1;
      stderr.write("That is not one of the choices.\n");
    }
    return undefined;
  }

  async function readAll(): Promise<string> {
    if (piped) {
      const rest: string[] = [];
      for (let next = await piped.lines.next(); !next.done; next = await piped.lines.next()) rest.push(next.value);
      return rest.join("\n");
    }
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return text;
  }

  let secrets: Promise<SecretStore> | undefined;

  const handlers: (() => void)[] = [];
  const onSigint = () => handlers.at(-1)?.();

  return {
    env,
    stdout: process.stdout,
    stderr,
    interactive,
    configDir,
    prompt: { line, secret, choose },
    readAll,
    openUrl: async (url) => {
      try {
        const [command, args] = openerFor(process.platform, url);
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
      } catch {
        // Best effort: the caller also prints the URL.
      }
    },
    fetch: globalThis.fetch,
    openSecrets: async () =>
      (secrets ??= openSecretStore({
        configDir,
        mode: credentialStoreMode(env["CORE_CREDENTIAL_STORE"]),
        warn: (message) => void stderr.write(`${message}\n`),
      })),
    onInterrupt: (handler) => {
      if (handlers.length === 0) process.on("SIGINT", onSigint);
      handlers.push(handler);
      return () => {
        const index = handlers.lastIndexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
        if (handlers.length === 0) process.off("SIGINT", onSigint);
      };
    },
  };
}

function openerFor(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]];
  return ["xdg-open", [url]];
}

function credentialStoreMode(value: string | undefined): "auto" | "keychain" | "file" {
  if (value === undefined || value === "") return "auto";
  if (value === "auto" || value === "keychain" || value === "file") return value;
  throw new CoreError("bad_request", "CORE_CREDENTIAL_STORE must be auto, keychain or file");
}
