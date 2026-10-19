import { createAzure } from "@ai-sdk/azure";
import { CoreError } from "@core/contracts";
import type { LanguageModel } from "ai";
import { AiSdkProvider, type Connection } from "./ai-sdk.js";

/**
 * Azure OpenAI through its v1 API, built on the Vercel AI SDK. The credential's `baseURL` is the
 * resource endpoint plus `/openai`, and the model id is the deployment name.
 */
export class AzureOpenAIProvider extends AiSdkProvider {
  protected languageModel(deployment: string, connection: Connection): LanguageModel {
    if (!connection.apiKey) {
      throw new CoreError("auth", `${this.id}: no API key configured`, { provider: this.id });
    }
    // `baseURL` and `apiKey` are always passed: without them the SDK reads AZURE_RESOURCE_NAME
    // and AZURE_API_KEY from the environment, which core must never do.
    const provider = createAzure({
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
      ...(connection.credentials?.headers ? { headers: connection.credentials.headers } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    // The chat completions model for the deployment, not the SDK's Responses default.
    return provider.chat(deployment);
  }

  async listModels(): Promise<string[]> {
    throw new CoreError(
      "bad_request",
      "Azure OpenAI cannot list deployments; route to your deployment, as azure:<deployment>",
      { provider: this.id },
    );
  }
}
