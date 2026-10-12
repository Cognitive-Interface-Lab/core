import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CoreError, type ToolPolicy } from "@core/contracts";
import type { RegisteredTool } from "../registry.js";

/** An MCP server to import tools from: a stdio command to spawn, or a ready-made transport. */
export type McpServerSpec =
  | { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { name: string; transport: Transport };

/** What the policy callback sees of an MCP tool: its original name and the hints it declared. */
export type McpToolInfo = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };

export interface McpConnection {
  readonly name: string;
  /** MCP tool names that could not be imported (name too long, or clashing with another tool). */
  readonly skipped: string[];
  tools(): RegisteredTool[];
  close(): Promise<void>;
}

const SERVER_NAME = /^[a-z0-9-]{1,20}$/;
const MAX_TOOL_NAME_LENGTH = 64;
const CLIENT_INFO = { name: "core", version: "0.1.0" };

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/**
 * Connects to an MCP server and turns its tools into registry entries named `<server>__<tool>`.
 * Tools are listed once, here. Imported tools are untrusted: by default they are allowed only on
 * the `local` channel and count as having side effects unless the server marks them
 * `readOnlyHint`. A stdio server gets the SDK's minimal default environment plus `spec.env`,
 * never this process's environment, so our API keys do not reach it.
 */
export async function connectMcpServer(
  spec: McpServerSpec,
  opts?: { policy?: (tool: McpToolInfo) => ToolPolicy },
): Promise<McpConnection> {
  if (!SERVER_NAME.test(spec.name)) {
    throw new CoreError(
      "bad_request",
      `invalid mcp server name "${spec.name}": expected 1 to 20 characters from a-z, 0-9 and "-"`,
    );
  }

  const transport =
    "transport" in spec
      ? spec.transport
      : new StdioClientTransport({
          command: spec.command,
          ...(spec.args !== undefined && { args: spec.args }),
          ...(spec.cwd !== undefined && { cwd: spec.cwd }),
          env: { ...getDefaultEnvironment(), ...spec.env },
          stderr: "ignore",
        });
  const client = new Client(CLIENT_INFO);

  let listed: ListedTool[];
  try {
    await client.connect(transport);
    listed = await listAllTools(client);
  } catch (error) {
    await client.close().catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new CoreError("unavailable", `mcp server "${spec.name}" failed to start: ${reason}`, { cause: error });
  }

  const tools: RegisteredTool[] = [];
  const skipped: string[] = [];
  const taken = new Set<string>();
  for (const tool of listed) {
    const name = `${spec.name}__${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    if (name.length > MAX_TOOL_NAME_LENGTH || taken.has(name)) {
      skipped.push(tool.name);
      continue;
    }
    taken.add(name);

    const info: McpToolInfo = { name: tool.name };
    if (tool.annotations !== undefined) {
      const { readOnlyHint, destructiveHint } = tool.annotations;
      info.annotations = {
        ...(readOnlyHint !== undefined && { readOnlyHint }),
        ...(destructiveHint !== undefined && { destructiveHint }),
      };
    }
    tools.push({
      definition: { name, description: tool.description ?? "", inputSchema: tool.inputSchema },
      policy: opts?.policy?.(info) ?? { channels: ["local"], sideEffects: info.annotations?.readOnlyHint !== true },
      source: `mcp:${spec.name}`,
      handler: async (args, ctx) => {
        const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal: ctx.signal });
        const text = describeContent(result["content"]);
        if (result["isError"] === true) throw new CoreError("unknown", text);
        return result["structuredContent"] ?? text;
      },
    });
  }

  let closing: Promise<void> | undefined;
  return {
    name: spec.name,
    skipped,
    tools: () => [...tools],
    close: () => (closing ??= client.close()),
  };
}

/** Lists every tool, following `nextCursor` pages. */
async function listAllTools(client: Client): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error("tools/list returned the same page cursor twice");
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

/** Text parts as they are, every other part as `[<type> content omitted]`, one per line. */
function describeContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      const { type, text } = (part ?? {}) as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? text : `[${typeof type === "string" ? type : "unknown"} content omitted]`;
    })
    .join("\n");
}
