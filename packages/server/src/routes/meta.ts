import {
  CoreError,
  type HealthResponse,
  type ModelsResponse,
  type ProviderStatus,
  type ProvidersResponse,
} from "@core/contracts";
import { PRESETS } from "@core/models";
import { jsonResponse } from "../errors.js";
import type { RouteModule } from "../handler.js";

export const meta: RouteModule = {
  specs: [
    { method: "GET", path: "/v1/health", summary: "Health of this core", answer: "HealthResponse" },
    {
      method: "GET",
      path: "/v1/providers",
      summary: "Providers and whether they are ready",
      answer: "ProvidersResponse",
    },
    { method: "GET", path: "/v1/models", summary: "Models a provider offers", answer: "ModelsResponse" },
  ],

  register(app, deps) {
    app.get("/v1/health", () => {
      const body: HealthResponse = {
        ok: true,
        version: deps.options.version,
        mode: deps.options.mode,
      };
      return jsonResponse(body);
    });

    app.get("/v1/providers", async (c) => {
      const registry = await deps.registry(c);
      const credentials = await deps.credentials(c);
      const providers: ProviderStatus[] = await Promise.all(
        registry.list().map(async (id) => {
          const preset = Object.hasOwn(PRESETS, id) ? PRESETS[id] : undefined;
          const requiresKey = preset?.requiresKey ?? false;
          const ready = requiresKey ? (await credentials.get(id)) !== undefined : true;
          return { id, ready, requiresKey };
        }),
      );
      const body: ProvidersResponse = { providers };
      return jsonResponse(body);
    });

    app.get("/v1/models", async (c) => {
      const provider = c.req.query("provider");
      if (!provider) throw new CoreError("bad_request", "provider is required");
      const registry = await deps.registry(c);
      const model = registry.get(provider);
      if (!model.listModels) {
        throw new CoreError("bad_request", `provider "${provider}" cannot list models`);
      }
      const models = await model.listModels({ signal: c.req.raw.signal });
      const body: ModelsResponse = { provider, models };
      return jsonResponse(body);
    });
  },
};
