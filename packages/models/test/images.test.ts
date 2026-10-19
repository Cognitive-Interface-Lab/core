import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreError, type ChatRequest } from "@core/contracts";
import {
  AnthropicProvider,
  MemoryCredentialStore,
  MockProvider,
  OpenAICompatibleProvider,
  PRESETS,
  type Preset,
} from "../src/index.js";
import { completionResponse, fakeFetch, type FakeFetch } from "./fixtures/openai-responses.js";
import { textMessage } from "./fixtures/anthropic-responses.js";

const SECRET = "sk-test-secret-key-123";

const IMAGE_HOST = "img.example.com";
/** The path and query are secrets of the caller's: no error may repeat them. */
const IMAGE_URL = `https://${IMAGE_HOST}/secret/a.png?token=LEAK`;
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const TEN_MIB_MESSAGE = `the image from ${IMAGE_HOST} is larger than 10 MiB`;

/** The PNG signature: enough for a download to be recognisably an image. */
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BASE64 = "iVBORw0KGgo=";

const ANTHROPIC_PRESET: Preset = {
  baseURL: "https://api.anthropic.com/v1",
  requiresKey: true,
  api: "anthropic",
  models: "anthropic",
};

function imageRequest(url: string, provider = "openai"): ChatRequest {
  return {
    model: { provider, model: "gpt-test" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", url },
        ],
      },
    ],
  };
}

function openaiFor(fake: FakeFetch): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "openai",
    preset: PRESETS["openai"],
    credentials: new MemoryCredentialStore({ openai: { apiKey: SECRET } }),
    fetch: fake.fetch,
  });
}

function anthropicFor(fake: FakeFetch): AnthropicProvider {
  return new AnthropicProvider({
    id: "anthropic",
    preset: ANTHROPIC_PRESET,
    credentials: new MemoryCredentialStore({ anthropic: { apiKey: SECRET } }),
    fetch: fake.fetch,
  });
}

/** A fake `fetch` whose image host answers `serveImage()` and whose every other host answers a completion. */
function imageHostFake(serveImage: () => Response): FakeFetch {
  return fakeFetch((request) => (new URL(request.url).hostname === IMAGE_HOST ? serveImage() : completionResponse()));
}

function imageResponse(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "image/png", ...headers } });
}

/** The same provider as `openaiFor`, but with no injected `fetch`: the SDK's own downloader and transport are in play. */
function openaiWithoutFetch(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "openai",
    preset: PRESETS["openai"],
    credentials: new MemoryCredentialStore({ openai: { apiKey: SECRET } }),
  });
}

/** A fake `fetch` whose image answer comes from `127.0.0.1` rather than from IMAGE_HOST. */
function loopbackImageFake(serveImage: () => Response): FakeFetch {
  return fakeFetch((request) => (new URL(request.url).hostname === "127.0.0.1" ? serveImage() : completionResponse()));
}

/** Every request that went to the model provider rather than to the image host. */
const providerCalls = (fake: FakeFetch) => fake.requests.filter((sent) => new URL(sent.url).hostname !== IMAGE_HOST);
const imageCalls = (fake: FakeFetch) => fake.requests.filter((sent) => new URL(sent.url).hostname === IMAGE_HOST);

/** The global `fetch`, replaced by one that fails the test if anything calls it. */
function forbidGlobalFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("global fetch must not be used")));
}

async function caught(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    expect(CoreError.is(error)).toBe(true);
    return error as CoreError;
  }
  throw new Error("expected the promise to reject");
}

/** The content of the first user message in the provider request recorded as `index`. */
function userContent(fake: FakeFetch, index = 0): unknown {
  const body = fake.requests[index]?.body;
  if (!body) throw new Error(`request ${index} had no body`);
  const messages = (body as { messages?: { role: string; content?: unknown }[] }).messages;
  const user = messages?.find((message) => message.role === "user");
  if (!user) throw new Error("the request body had no user message");
  return user.content;
}

/** Asserts a download failure: a bad_request that names the host, repeats nothing of the URL, and never reached the model. */
function expectDownloadFailure(error: CoreError, message: string, fake: FakeFetch): void {
  expect(error.code).toBe("bad_request");
  expect(error.message).toBe(message);
  expect(error.message).toContain(IMAGE_HOST);
  expect(error.message).not.toContain("secret");
  expect(error.message).not.toContain("LEAK");
  expect(providerCalls(fake)).toHaveLength(0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("images in OpenAI-compatible requests", () => {
  it("sends a data-URL image as an image_url part next to the text, without any download", async () => {
    const fake = imageHostFake(() => imageResponse(PNG_BYTES));
    const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
    await openaiFor(fake).chat({
      model: { provider: "openai", model: "gpt-test" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", url: dataUrl },
          ],
        },
      ],
    });

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url).toBe(OPENAI_CHAT_URL);
    expect(userContent(fake)).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: dataUrl } },
    ]);
  });

  it("keeps the media type a data URL names when its bytes do not reveal one", async () => {
    const fake = imageHostFake(() => imageResponse(PNG_BYTES));
    const dataUrl = "data:image/webp;base64,AAAA";
    await openaiFor(fake).chat(imageRequest(dataUrl));

    expect(fake.requests).toHaveLength(1);
    expect(userContent(fake)).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: dataUrl } },
    ]);
  });

  it("downloads an http(s) image once through the injected fetch and sends its bytes as a data URL", async () => {
    const globalFetch = forbidGlobalFetch();
    const fake = imageHostFake(() => imageResponse(PNG_BYTES));
    await openaiFor(fake).chat(imageRequest(IMAGE_URL));

    expect(globalFetch).not.toHaveBeenCalled();
    const downloads = imageCalls(fake);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.url).toBe(IMAGE_URL);
    expect(downloads[0]?.method).toBe("GET");
    expect(fake.requests.filter((sent) => sent.url === IMAGE_URL)).toHaveLength(1);
    expect(providerCalls(fake)).toHaveLength(1);
    expect(providerCalls(fake)[0]?.url).toBe(OPENAI_CHAT_URL);

    expect(Buffer.from(PNG_BYTES).toString("base64")).toBe(PNG_BASE64);
    expect(userContent(fake, fake.requests.findIndex((sent) => sent.url === OPENAI_CHAT_URL))).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ]);
  });
});

describe("images in Anthropic requests", () => {
  it("passes an http(s) image on as a url source and downloads nothing", async () => {
    const globalFetch = forbidGlobalFetch();
    const fake = fakeFetch(() => textMessage("ok"));
    await anthropicFor(fake).chat(imageRequest(IMAGE_URL, "anthropic"));

    expect(globalFetch).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(imageCalls(fake)).toHaveLength(0);
    expect(userContent(fake)).toContainEqual({ type: "image", source: { type: "url", url: IMAGE_URL } });
  });
});

describe("failed image downloads", () => {
  it("rejects a 404 with bad_request that names the host and nothing of the URL", async () => {
    const globalFetch = forbidGlobalFetch();
    const fake = imageHostFake(() => new Response("not found", { status: 404 }));
    const error = await caught(openaiFor(fake).chat(imageRequest(IMAGE_URL)));

    expectDownloadFailure(error, `could not download the image from ${IMAGE_HOST}: HTTP 404`, fake);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("rejects an answer that is not an image", async () => {
    const globalFetch = forbidGlobalFetch();
    const fake = imageHostFake(
      () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const error = await caught(openaiFor(fake).chat(imageRequest(IMAGE_URL)));

    expectDownloadFailure(error, `${IMAGE_HOST} did not answer with an image`, fake);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("rejects a streamed body larger than 10 MiB that declares no content-length", async () => {
    const globalFetch = forbidGlobalFetch();
    const fake = imageHostFake(() => {
      // Eleven 1 MiB chunks: only counting the bytes as they arrive can see that this is too much.
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 11) return controller.close();
          sent += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      const response = new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
      expect(response.headers.get("content-length")).toBeNull();
      return response;
    });
    const error = await caught(openaiFor(fake).chat(imageRequest(IMAGE_URL)));

    expectDownloadFailure(error, TEN_MIB_MESSAGE, fake);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("rejects a content-length over 10 MiB even when the body is small", async () => {
    const globalFetch = forbidGlobalFetch();
    const fake = imageHostFake(() => imageResponse(PNG_BYTES, { "content-length": String(20 * 1024 * 1024) }));
    const error = await caught(openaiFor(fake).chat(imageRequest(IMAGE_URL)));

    expectDownloadFailure(error, TEN_MIB_MESSAGE, fake);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("lets a CoreError thrown by the injected fetch through unchanged", async () => {
    const globalFetch = forbidGlobalFetch();
    const fake = fakeFetch((request) => {
      if (new URL(request.url).hostname === IMAGE_HOST) {
        throw new CoreError("auth", "blocked address", { provider: "guard" });
      }
      return completionResponse();
    });
    const error = await caught(openaiFor(fake).chat(imageRequest(IMAGE_URL)));

    expect(error.code).toBe("auth");
    expect(error.message).toBe("blocked address");
    expect(error.provider).toBe("guard");
    expect(imageCalls(fake)).toHaveLength(1);
    expect(providerCalls(fake)).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("gives code aborted, not unavailable, when the caller aborts during a download", async () => {
    const globalFetch = forbidGlobalFetch();
    // The image host never answers until the request's signal fires, then rejects with its reason.
    const fake = fakeFetch((request, signal) => {
      if (new URL(request.url).hostname !== IMAGE_HOST) return completionResponse();
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = caught(openaiFor(fake).chat(imageRequest(IMAGE_URL), { signal: controller.signal }));

    // Abort only once the download is really in flight.
    for (let waited = 0; imageCalls(fake).length === 0; waited += 1) {
      if (waited > 200) throw new Error("the image was never requested");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    const error = await pending;

    expect(error.code).toBe("aborted");
    expect(imageCalls(fake)).toHaveLength(1);
    expect(providerCalls(fake)).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("without an injected fetch", () => {
  it("never serves a download through the global fetch: the SDK's own downloader fails on its own terms", async () => {
    const globalFetch = forbidGlobalFetch();
    const error = await caught(openaiWithoutFetch().chat(imageRequest("http://127.0.0.1/a.png")));

    expect(globalFetch).not.toHaveBeenCalled();
    expect(error.message).toContain("127.0.0.1");
    // That wording is core's own downloader's; a core downloader wired with no fetch would also fail without
    // calling one, and only the message tells the two apart.
    expect(error.message).not.toContain("could not download the image");
  });

  it("reaches the injected fetch with the same URL, once, as a GET, and the chat request follows", async () => {
    const globalFetch = forbidGlobalFetch();
    const imageUrl = "http://127.0.0.1/a.png";
    const fake = loopbackImageFake(() => imageResponse(PNG_BYTES));
    await openaiFor(fake).chat(imageRequest(imageUrl));

    expect(globalFetch).not.toHaveBeenCalled();
    expect(fake.requests.map((sent) => sent.url)).toEqual([imageUrl, OPENAI_CHAT_URL]);
    expect(fake.requests[0]?.method).toBe("GET");
    expect(userContent(fake, 1)).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ]);
  });
});

describe("MockProvider with images", () => {
  it("echoes the text and counts only the text, never the image", async () => {
    const response = await new MockProvider().chat({
      model: { provider: "mock", model: "echo" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", url: "https://example.com/a.png" },
          ],
        },
      ],
    });

    expect(response.message.content).toBe("echo: look");
    expect(response.usage?.inputTokens).toBe(4);
  });

  it("joins the text parts around an image with a newline", async () => {
    const response = await new MockProvider().chat({
      model: { provider: "mock", model: "echo" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "image", url: "https://example.com/a.png" },
            { type: "text", text: "b" },
          ],
        },
      ],
    });

    expect(response.message.content).toBe("echo: a\nb");
    expect(response.usage?.inputTokens).toBe(3);
  });
});
