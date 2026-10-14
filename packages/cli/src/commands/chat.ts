import { parseArgs } from "node:util";
import { formatModelRef, type Message, type ModelRef } from "@core/contracts";
import { runTurn } from "@core/runtime";
import { ToolRegistry } from "@core/tools";
import { loadConfig } from "../config.js";
import { UsageError, type Command, type Io } from "../run.js";
import { chooseRoute, openTurnRouter, printTurn } from "./ask.js";

const HELP = `/model <provider:model,...>  switch the models for the next answers
/reset                      forget the conversation so far
/help                       show this list
/exit                       leave (Ctrl+D also works)
`;

export const chatCommand: Command = {
  summary: "talk with a model, keeping the conversation",
  usage: `[--model <provider:model,...>] [--system <text>]

Type a message at the "> " prompt. Ctrl+C during an answer stops just that answer.
Commands: /model <refs>, /reset, /help, /exit.`,
  async run(args: string[], io: Io): Promise<number> {
    let parsed: ReturnType<typeof parseArgs<{ options: { model: { type: "string" }; system: { type: "string" } }; allowPositionals: true }>>;
    try {
      parsed = parseArgs({
        args,
        options: { model: { type: "string" }, system: { type: "string" } },
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
    }
    if (parsed.positionals.length > 0) throw new UsageError(`unexpected argument: ${parsed.positionals[0]}`);

    const config = await loadConfig(io.configDir);
    let route = chooseRoute(parsed.values.model, io.env, config);
    const { router, log } = await openTurnRouter(io, config);

    const system: Message[] = parsed.values.system ? [{ role: "system", content: parsed.values.system }] : [];
    let history: Message[] = [...system];
    const tools = new ToolRegistry();

    io.stderr.write(`Chatting via ${describe(route)}. Type /help for commands, /exit to leave.\n`);

    for (;;) {
      const line = await io.prompt.line("> ");
      if (line === undefined) {
        if (io.interactive) io.stderr.write("\n");
        return 0;
      }
      const text = line.trim();
      if (text === "") continue;

      if (text.startsWith("/")) {
        const [command = "", ...rest] = text.split(/\s+/);
        if (command === "/exit") return 0;
        if (command === "/help") {
          io.stdout.write(HELP);
        } else if (command === "/reset") {
          history = [...system];
          io.stderr.write("[conversation cleared]\n");
        } else if (command === "/model") {
          try {
            if (rest.length === 0) throw new UsageError(`usage: /model <provider:model,...> (now: ${describe(route)})`);
            route = chooseRoute(rest.join(" "), io.env, config);
            io.stderr.write(`[now using ${describe(route)}]\n`);
          } catch (error) {
            if (!(error instanceof UsageError)) throw error;
            io.stderr.write(`error: ${error.message}\n`);
          }
        } else {
          io.stderr.write(`error: unknown command ${command}; try /help\n`);
        }
        continue;
      }

      const user: Message = { role: "user", content: text };
      log.reset();
      const interrupted = new AbortController();
      const unsubscribe = io.onInterrupt(() => interrupted.abort());
      try {
        const events = runTurn({
          router,
          route: route.map((model) => ({ model })),
          tools,
          channel: "local",
          messages: [...history, user],
          signal: interrupted.signal,
        });
        const finish = await printTurn(events, io, log);
        if (interrupted.signal.aborted) {
          io.stderr.write("[stopped]\n");
        } else if (finish.reason === "stop") {
          history.push(user, ...finish.messages);
        }
        // Any other ending was reported by printTurn; the message is not kept, so the next try starts clean.
      } finally {
        unsubscribe();
      }
    }
  },
};

function describe(route: ModelRef[]): string {
  return route.map(formatModelRef).join(", ");
}
