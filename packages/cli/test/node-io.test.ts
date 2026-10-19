import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createNodeIo } from "../src/io.js";

type ReadlineOptions = { input?: unknown; output?: unknown; terminal?: boolean };

/** The part of a readline `Interface` that `createNodeIo` uses, recording what it was asked to do. */
type FakeInterface = {
  options: ReadlineOptions;
  /** Every `question(prompt, cb)` call; a test answers by calling `answer`. */
  questions: { prompt: string; answer(text: string): void }[];
  closed: boolean;
  question(prompt: string, answer: (text: string) => void): void;
  once(event: string, handler: () => void): FakeInterface;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
};

/** A fake `node:readline`: every `createInterface` is recorded, and piped lines come from one shared queue. */
const readline = vi.hoisted(() => {
  const created: FakeInterface[] = [];
  const buffered: string[] = [];
  const waiting: ((result: IteratorResult<string>) => void)[] = [];

  // Like a real readline over a pipe: a line is handed to whoever asks next, or kept until someone does.
  const pipedLines: AsyncIterator<string> = {
    next: () => {
      const line = buffered.shift();
      if (line !== undefined) return Promise.resolve({ done: false, value: line });
      return new Promise((resolve) => waiting.push(resolve));
    },
  };

  return {
    created,
    reset: () => {
      created.length = 0;
      buffered.length = 0;
      waiting.length = 0;
    },
    /** A line arrives on the pipe. */
    pipe: (line: string) => {
      const waiter = waiting.shift();
      if (waiter) waiter({ done: false, value: line });
      else buffered.push(line);
    },
    createInterface: (options: ReadlineOptions): FakeInterface => {
      const handlers = new Map<string, (() => void)[]>();
      const rl: FakeInterface = {
        options,
        questions: [],
        closed: false,
        question: (prompt, answer) => {
          rl.questions.push({ prompt, answer });
        },
        once: (event, handler) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          return rl;
        },
        close: () => {
          // A real readline emits "close" once, however many times it is closed.
          if (rl.closed) return;
          rl.closed = true;
          for (const handler of handlers.get("close") ?? []) handler();
        },
        [Symbol.asyncIterator]: () => pipedLines,
      };
      created.push(rl);
      return rl;
    },
  };
});

vi.mock("node:readline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:readline")>()),
  createInterface: readline.createInterface,
}));

const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
let stderrWrite: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  readline.reset();
  stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrWrite.mockRestore();
  if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
  else Reflect.deleteProperty(process.stdin, "isTTY");
});

/** `createNodeIo()` as it behaves with stdin attached to a terminal, or not. It reads `isTTY` once, right here. */
function ioWithTty(tty: boolean | undefined) {
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true, writable: true });
  return createNodeIo();
}

/** What has been written to stderr, chunk by chunk. */
function written(): string[] {
  return stderrWrite.mock.calls.map(([chunk]) => String(chunk));
}

/** Lets everything that is ready to run, run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("prompt.line in a terminal", () => {
  it("hands the question to readline as its prompt", async () => {
    const io = ioWithTty(true);

    const answer = io.prompt.line("Project name: ");
    await settle();

    expect(readline.created).toHaveLength(1);
    expect(readline.created[0]?.options.terminal).toBe(true);
    expect(readline.created[0]?.questions.map((q) => q.prompt)).toEqual(["Project name: "]);

    readline.created[0]?.questions[0]?.answer("done");
    await answer;
  });

  it("writes nothing to stderr itself, because readline's first draw would erase it", async () => {
    const io = ioWithTty(true);

    const answer = io.prompt.line("Project name: ");
    await settle();

    expect(written()).toEqual([]);

    readline.created[0]?.questions[0]?.answer("done");
    await answer;
  });

  it("resolves to the answer readline delivers", async () => {
    const io = ioWithTty(true);

    const answer = io.prompt.line("Project name: ");
    await settle();
    readline.created[0]?.questions[0]?.answer("trilix");

    await expect(answer).resolves.toBe("trilix");
  });

  it("when aborted while waiting, writes a newline, closes that readline and resolves undefined", async () => {
    const io = ioWithTty(true);
    const controller = new AbortController();

    const answer = io.prompt.line("Project name: ", { signal: controller.signal });
    await settle();
    expect(readline.created[0]?.closed).toBe(false);
    expect(written()).toEqual([]);

    controller.abort();

    await expect(answer).resolves.toBeUndefined();
    expect(written()).toEqual(["\n"]);
    expect(readline.created).toHaveLength(1);
    expect(readline.created[0]?.closed).toBe(true);
  });
});

describe("prompt.line with piped input", () => {
  it("writes the question to stderr, then resolves to the next piped line and writes a newline", async () => {
    const io = ioWithTty(false);

    const answer = io.prompt.line("Project name: ");
    await settle();

    // Still waiting for the pipe: the question is out, the newline is not.
    expect(written()).toEqual(["Project name: "]);

    readline.pipe("trilix");

    await expect(answer).resolves.toBe("trilix");
    expect(written()).toEqual(["Project name: ", "\n"]);
  });

  it("treats a missing isTTY the same as a pipe", async () => {
    const io = ioWithTty(undefined);

    const answer = io.prompt.line("Project name: ");
    readline.pipe("trilix");

    await expect(answer).resolves.toBe("trilix");
    expect(written()).toEqual(["Project name: ", "\n"]);
    expect(readline.created.map((rl) => rl.options.terminal)).toEqual([false]);
  });

  it("answers later questions from the same non-terminal readline, in order, losing no line", async () => {
    const io = ioWithTty(false);
    // Both lines arrive before the second question is asked.
    readline.pipe("first");
    readline.pipe("second");

    await expect(io.prompt.line("One? ")).resolves.toBe("first");
    await expect(io.prompt.line("Two? ")).resolves.toBe("second");

    expect(readline.created).toHaveLength(1);
    expect(readline.created[0]?.options.terminal).toBe(false);
    // The lines are read as a stream, never by asking readline a question.
    expect(readline.created[0]?.questions).toEqual([]);
    expect(written()).toEqual(["One? ", "\n", "Two? ", "\n"]);
  });
});

describe("prompt.line with a signal that is already aborted", () => {
  it.each([
    ["in a terminal", true],
    ["with piped input", false],
  ])("%s, resolves undefined without creating a readline or writing anything", async (_where, tty) => {
    const io = ioWithTty(tty);
    const controller = new AbortController();
    controller.abort();

    await expect(io.prompt.line("Project name: ", { signal: controller.signal })).resolves.toBeUndefined();

    expect(readline.created).toEqual([]);
    expect(written()).toEqual([]);
  });
});
