import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Channel } from "@core/contracts";
import type { ConfirmFn, ToolRegistry } from "../registry.js";

/**
 * Offers a registry's tools to MCP clients through the same policy gate as everything else.
 * Only the tools the `channel` may call are listed, read from the registry at each request, and
 * every call goes through `ToolRegistry.call`, so channel policy and confirmation apply. Without
 * `confirm`, side-effect tools are still listed but their calls are refused with
 * `needs confirmation`. The caller connects a transport.
 */
export function createMcpServer(
  registry: ToolRegistry,
  opts: { name: string; version: string; channel: Channel; confirm?: ConfirmFn },
): Server {
  const server = new Server({ name: opts.name, version: opts.version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: registry.listFor(opts.channel).map((definition) => ({
      name: definition.name,
      description: definition.description,
      // MCP requires an object schema; keep the author's schema and only fill in a missing type.
      inputSchema: { type: "object" as const, ...definition.inputSchema },
      annotations: { readOnlyHint: !registry.get(definition.name).policy.sideEffects },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await registry.call(
      { id: randomUUID(), name: request.params.name, arguments: request.params.arguments ?? {} },
      { channel: opts.channel, ...(opts.confirm !== undefined && { confirm: opts.confirm }), signal: extra.signal },
    );
    return { content: [{ type: "text" as const, text: result.content }], isError: result.isError };
  });

  return server;
}
