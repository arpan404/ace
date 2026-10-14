import { z } from "zod";
import { opencodeNative } from "@ace/provider-kit/access-modes";
import type { PermissionMode } from "@ace/protocol";

export interface OpenCodeRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}
export interface OpenCodePolicy {
  agent: "build" | "plan";
  /**
   * Session rules ace owns for an ace mode, written through OpenCode's session API and never
   * into the project's opencode.json. Undefined leaves the session's rules alone (Custom).
   */
  rules?: OpenCodeRule[];
}

const reads = ["read", "glob", "grep", "list", "lsp"].map((action): OpenCodeRule => ({
  action,
  resource: "*",
  effect: "allow",
}));
/** Env files stay a question even under Ask's free reads. */
const envReads: OpenCodeRule[] = ["*.env", "*.env.*"].map((resource) => ({
  action: "read",
  resource,
  effect: "ask",
}));

/**
 * The OpenCode agent and per-session rules for a native selector. Read-only is the native Plan
 * agent with no ace rules; Ask asks for everything but reads; Full access allows everything.
 * Rules are evaluated last-match-wins, so the catch-all comes first.
 */
export function opencodePolicy(mode: PermissionMode): OpenCodePolicy {
  switch (mode) {
    case opencodeNative.readOnly:
      return { agent: "plan", rules: [] };
    case opencodeNative.ask:
      return {
        agent: "build",
        rules: [{ action: "*", resource: "*", effect: "ask" }, ...reads, ...envReads],
      };
    case opencodeNative.fullAccess:
      return { agent: "build", rules: [{ action: "*", resource: "*", effect: "allow" }] };
    default:
      // Advanced "Custom": OpenCode's own agent and the person's configured rules.
      return { agent: z.enum(["build", "plan"]).parse(mode) };
  }
}
