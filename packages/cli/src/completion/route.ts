import { EnvCredentialStore, PRESETS } from "@core/models";
import type { Io } from "../run.js";
import { makeProvider } from "../setup.js";

/** How long Tab waits for the local Ollama to list its models. */
export const OLLAMA_LIST_TIMEOUT_MS = 1500;

/**
 * Candidates for a whole route word, each a complete replacement for `token`. Completes the
 * segment after the last comma: `provider:` prefixes, and Ollama's models from the local server.
 * Remote providers' models are not completed (no network on Tab). Never opens the secret store,
 * never writes output, never throws.
 */
export async function completeRoute(token: string, io: Io): Promise<string[]> {
  const comma = token.lastIndexOf(",");
  const head = token.slice(0, comma + 1);
  const segment = token.slice(comma + 1);

  let candidates: string[] = [];
  if (!segment.includes(":")) {
    candidates = Object.keys(PRESETS)
      .sort()
      .map((id) => `${id}:`);
  } else if (segment.startsWith("ollama:")) {
    candidates = (await ollamaModels(io)).map((model) => `ollama:${model}`);
  }

  const result: string[] = [];
  for (const candidate of candidates) {
    const word = head + candidate;
    if (word.startsWith(token) && !result.includes(word)) result.push(word);
  }
  return result;
}

async function ollamaModels(io: Io): Promise<string[]> {
  // A plain timer rather than AbortSignal.timeout, whose unreferenced timer would let the process
  // exit before the timeout settles anything.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("listing Ollama's models timed out", "TimeoutError"));
      reject(controller.signal.reason);
    }, OLLAMA_LIST_TIMEOUT_MS);
  });
  try {
    const provider = makeProvider("ollama", new EnvCredentialStore(io.env), io);
    // The race also covers a fetch that ignores its signal.
    return await Promise.race([provider.listModels({ signal: controller.signal }), timedOut]);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
