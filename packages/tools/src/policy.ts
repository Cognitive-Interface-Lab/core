import type { Channel, ToolPolicy } from "@core/contracts";

/** True when the policy names no channels (every channel may call) or lists `channel`. */
export function isAllowedOn(policy: ToolPolicy, channel: Channel): boolean {
  return policy.channels === undefined || policy.channels.includes(channel);
}
