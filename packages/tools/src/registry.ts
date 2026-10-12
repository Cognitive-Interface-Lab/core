import {
  CoreError,
  ToolDefinitionSchema,
  ToolPolicySchema,
  type Channel,
  type ToolCall,
  type ToolDefinition,
  type ToolPolicy,
  type ToolResult,
} from "@core/contracts";
import { isAllowedOn } from "./policy.js";

const MAX_ERROR_LENGTH = 500;

/** Asks whether a call that has side effects may run. Resolving false or throwing declines it. */
export type ConfirmFn = (call: ToolCall, tool: ToolDefinition) => Promise<boolean>;

export type ToolContext = { channel: Channel; signal?: AbortSignal; confirm?: ConfirmFn };

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export type RegisteredTool = {
  definition: ToolDefinition;
  policy: ToolPolicy;
  handler: ToolHandler;
  /** "local" or "mcp:<server>". */
  source: string;
};

/** Every tool a turn may offer, local or imported. Names are unique. */
export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  /** Throws `bad_request` for an invalid definition or policy, or a name that is already taken. */
  register(tool: RegisteredTool): this {
    const definition = ToolDefinitionSchema.safeParse(tool.definition);
    if (!definition.success) {
      throw new CoreError("bad_request", `invalid tool definition: ${describeIssues(definition.error)}`);
    }
    const policy = ToolPolicySchema.safeParse(tool.policy);
    if (!policy.success) {
      throw new CoreError("bad_request", `invalid policy for tool "${definition.data.name}": ${describeIssues(policy.error)}`);
    }
    if (this.#tools.has(definition.data.name)) {
      throw new CoreError("bad_request", `tool "${definition.data.name}" is already registered`);
    }
    this.#tools.set(definition.data.name, {
      definition: definition.data,
      policy: policy.data,
      handler: tool.handler,
      source: tool.source,
    });
    return this;
  }

  /** Returns whether a tool of that name was registered. */
  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  /** Throws `not_found` for an unknown name. */
  get(name: string): RegisteredTool {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw new CoreError("not_found", `unknown tool "${name}"`);
    return tool;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Every definition, sorted by name. */
  list(): ToolDefinition[] {
    return this.#sorted(() => true);
  }

  /** The definitions whose policy has no `channels`, or lists `channel`, sorted by name. */
  listFor(channel: Channel): ToolDefinition[] {
    return this.#sorted((tool) => isAllowedOn(tool.policy, channel));
  }

  /**
   * Runs one tool call through the policy gate. Never throws: a refusal or a failure is a result
   * with `isError` set, which the model can read. Checks run in this order: the tool exists, the
   * channel may call it, the call is not aborted, side effects are confirmed, then the handler runs.
   */
  async call(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const { name } = call;
    const refuse = (content: string): ToolResult => ({
      toolCallId: call.id,
      toolName: name,
      content,
      isError: true,
    });

    const tool = this.#tools.get(name);
    if (tool === undefined) return refuse(`unknown tool "${name}"`);
    if (!isAllowedOn(tool.policy, ctx.channel)) {
      return refuse(`tool "${name}" is not allowed on channel "${ctx.channel}"`);
    }
    if (ctx.signal?.aborted) return refuse(`tool "${name}" was aborted`);

    if (tool.policy.sideEffects) {
      if (ctx.confirm === undefined) return refuse(`tool "${name}" needs confirmation`);
      if (!(await isConfirmed(ctx.confirm, call, tool.definition))) return refuse(`tool "${name}" was declined`);
    }

    let value: unknown;
    try {
      value = await tool.handler(call.arguments, ctx);
    } catch (error) {
      const message = error instanceof Error && error.message !== "" ? error.message : `tool "${name}" failed`;
      return refuse(message.slice(0, MAX_ERROR_LENGTH));
    }

    const content = serialise(value);
    if (content === undefined) return refuse(`tool "${name}" returned a value that is not JSON`);
    return { toolCallId: call.id, toolName: name, content, isError: false };
  }

  #sorted(keep: (tool: RegisteredTool) => boolean): ToolDefinition[] {
    return [...this.#tools.values()]
      .filter(keep)
      .map((tool) => tool.definition)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}

function describeIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** A string as is, `undefined` as "null", anything else as JSON. Undefined when it cannot be JSON. */
function serialise(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return "null";
  try {
    // JSON.stringify returns undefined, not a throw, for functions and symbols.
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Only an explicit `true` confirms; a rejection or a throw declines. */
async function isConfirmed(confirm: ConfirmFn, call: ToolCall, tool: ToolDefinition): Promise<boolean> {
  try {
    return (await confirm(call, tool)) === true;
  } catch {
    return false;
  }
}
