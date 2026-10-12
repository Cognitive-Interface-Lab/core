import {
  CoreError,
  ToolDefinitionSchema,
  ToolPolicySchema,
  type Channel,
  type ToolCall,
  type ToolDefinition,
  type ToolPolicy,
} from "@core/contracts";

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
    return this.#sorted((tool) => tool.policy.channels === undefined || tool.policy.channels.includes(channel));
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
