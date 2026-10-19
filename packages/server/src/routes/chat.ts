import { ChatCallSchema } from "@core/contracts";
import { askResultFrom, type RoutedResponse } from "@core/models";
import { httpStatus, jsonResponse } from "../errors.js";
import type { RouteModule } from "../handler.js";

export const chat: RouteModule = {
  specs: [
    {
      method: "POST",
      path: "/v1/chat",
      summary: "One model answer as JSON, what core ask --json prints",
      body: "ChatCall",
      answer: "AskResult",
    },
  ],

  register(app, deps) {
    app.post("/v1/chat", async (c) => {
      const call = await deps.body(c, ChatCallSchema);
      const { router, route } = await deps.model(c, call);

      let outcome: { response: RoutedResponse } | { error: unknown };
      try {
        const response = await router.chat(
          {
            messages: call.messages,
            ...(call.outputSchema !== undefined && { outputSchema: call.outputSchema }),
            ...(call.maxOutputTokens !== undefined && { maxOutputTokens: call.maxOutputTokens }),
            ...(call.temperature !== undefined && { temperature: call.temperature }),
          },
          route,
          { signal: c.req.raw.signal },
        );
        outcome = { response };
      } catch (error) {
        outcome = { error };
      }

      // The attempts travel in the body, so a failure answers with the AskResult, not an ApiErrorBody.
      const result = askResultFrom(outcome, { withOutput: call.outputSchema !== undefined });
      return jsonResponse(result, result.ok ? 200 : httpStatus(result.error.code));
    });
  },
};
