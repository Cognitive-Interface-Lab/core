import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore, type SecretStore } from "@core/credentials";
import type { CoreHandler } from "@core/server";
import type { Io } from "../src/run.js";

/** A scripted line answer: the text, `undefined` for end of input, or a function that waits (it gets the prompt's signal). */
export type LineAnswer = string | undefined | ((signal: AbortSignal | undefined) => Promise<string | undefined>);

/** A line answer that waits until the prompt's signal aborts, then answers `undefined`, as the real prompt does. */
export const untilAborted: LineAnswer = (signal) =>
  new Promise((resolve) => {
    if (signal === undefined || signal.aborted) return resolve(undefined);
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });

/** Scripted answers, handed out in order; once a script runs out the prompt answers `undefined` (end of input). */
export type Answers = {
  line?: LineAnswer[];
  secret?: (string | undefined)[];
  choose?: (number | undefined)[];
};

export type FakeIoOptions = Partial<Omit<Io, "prompt">> & {
  answers?: Answers;
  /** What `readAll` returns. */
  stdin?: string;
  /** The store `openSecrets` returns. Default: a fresh `MemorySecretStore`. */
  secretStore?: SecretStore;
};

/** One call of the fake `serve`: the handler and port it was given, and how many times `close` ran. */
export type Served = { handler: CoreHandler; port: number; closes: number };

export type FakeIo = {
  io: Io;
  stdout(): string;
  stderr(): string;
  /** URLs passed to `openUrl`. */
  opened: string[];
  /** Every question asked through `prompt`, in order. */
  asked: string[];
  /** The `signal` each `prompt.line` call was given (`undefined` when it got none), in order. */
  lineSignals: (AbortSignal | undefined)[];
  /** The store behind `openSecrets`. */
  secrets: SecretStore;
  /** How many times `openSecrets` was called. */
  secretsOpened(): number;
  /** Plays Ctrl+C: calls the most recently subscribed handler. Returns whether there was one. */
  interrupt(): boolean;
  /** How many interrupt handlers are subscribed right now. */
  interruptHandlers(): number;
  /** Every call of the fake `serve`, in order. */
  served: Served[];
  /** Resolves with the first call of `serve`, once it happens. Never rejects: bound the wait in the test. */
  whenServed(): Promise<Served>;
};

const tempDirs: string[] = [];

/** Removes every temporary config directory made by `fakeIo`. Call from `afterEach`. */
export function cleanupFakeIo(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** An `Io` that touches nothing outside memory and a fresh temporary config directory. */
export function fakeIo(overrides: FakeIoOptions = {}): FakeIo {
  let out = "";
  let err = "";
  const opened: string[] = [];
  const asked: string[] = [];
  const lineSignals: (AbortSignal | undefined)[] = [];
  const handlers: (() => void)[] = [];
  const scripts = {
    line: [...(overrides.answers?.line ?? [])],
    secret: [...(overrides.answers?.secret ?? [])],
    choose: [...(overrides.answers?.choose ?? [])],
  };
  const secrets = overrides.secretStore ?? new MemorySecretStore();
  let secretsOpened = 0;
  const served: Served[] = [];
  let firstServed: (call: Served) => void = () => {};
  const whenServed = new Promise<Served>((resolve) => {
    firstServed = resolve;
  });

  let configDir = overrides.configDir;
  if (configDir === undefined) {
    const root = mkdtempSync(join(tmpdir(), "core-cli-test-"));
    tempDirs.push(root);
    configDir = join(root, "config");
  }

  const io: Io = {
    env: overrides.env ?? {},
    stdout: overrides.stdout ?? { write: (s) => void (out += s) },
    stderr: overrides.stderr ?? { write: (s) => void (err += s) },
    interactive: overrides.interactive ?? false,
    configDir,
    prompt: {
      line: async (question, opts) => {
        asked.push(question);
        lineSignals.push(opts?.signal);
        const answer = scripts.line.shift();
        return typeof answer === "function" ? answer(opts?.signal) : answer;
      },
      secret: async (question) => {
        asked.push(question);
        return scripts.secret.shift();
      },
      choose: async (question) => {
        asked.push(question);
        return scripts.choose.shift();
      },
    },
    readAll: overrides.readAll ?? (async () => overrides.stdin ?? ""),
    openUrl:
      overrides.openUrl ??
      (async (url) => {
        opened.push(url);
      }),
    fetch:
      overrides.fetch ??
      (async () => {
        throw new TypeError("fetch is not available in this test");
      }),
    openSecrets:
      overrides.openSecrets ??
      (async () => {
        secretsOpened += 1;
        return secrets;
      }),
    onInterrupt:
      overrides.onInterrupt ??
      ((handler) => {
        handlers.push(handler);
        return () => {
          const index = handlers.lastIndexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        };
      }),
    serve:
      overrides.serve ??
      (async (handler, port) => {
        const call: Served = { handler, port, closes: 0 };
        served.push(call);
        firstServed(call);
        return {
          url: `http://127.0.0.1:${port}`,
          close: async () => {
            call.closes += 1;
          },
        };
      }),
  };

  return {
    io,
    stdout: () => out,
    stderr: () => err,
    opened,
    asked,
    lineSignals,
    secrets,
    secretsOpened: () => secretsOpened,
    interrupt: () => {
      const handler = handlers.at(-1);
      handler?.();
      return handler !== undefined;
    },
    interruptHandlers: () => handlers.length,
    served,
    whenServed: () => whenServed,
  };
}
