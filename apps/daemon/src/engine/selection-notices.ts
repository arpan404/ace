import type { Fact } from "@ace/core";
import { AccessMode } from "@ace/protocol";
import { customNative, type AccessSelection } from "./permission-ceiling.ts";

const labels: Record<AccessMode, string> = {
  "read-only": "Read-only",
  ask: "Ask",
  "auto-review": "Auto review",
  "full-access": "Full access",
};

/** What runs, in the words the access picker uses. */
function running(selection: AccessSelection | null): string {
  if (selection === null) return "its own default";
  const custom = customNative(selection);
  if (custom !== undefined) return `the custom mode ${custom}`;
  const mode = AccessMode.safeParse(selection);
  return mode.success ? labels[mode.data] : selection;
}

/** The transcript line for an access choice the session couldn't run, and what runs instead. */
export function unhonouredAccessNotice(input: {
  agent: string;
  at: number;
  requested: AccessMode;
  selection: AccessSelection | null;
}): Fact {
  return {
    type: "item.upsert",
    agent: input.agent,
    item: `access-unavailable:${input.at}`,
    draft: {
      type: "notice",
      level: "warning",
      code: "access_mode_unavailable",
      text: `This agent doesn't offer ${labels[input.requested]}, so it runs with ${running(input.selection)}.`,
      complete: true,
    },
  };
}

/** The transcript line for launch options the provider didn't take; it runs its defaults. */
export function refusedOptionsNotice(input: {
  agent: string;
  at: number;
  dropped: readonly (readonly [string, unknown])[];
}): Fact {
  const named = input.dropped.map(([key, value]) =>
    key === "effort" ? `the ${String(value)} thinking level` : `${key} ${String(value)}`,
  );
  return {
    type: "item.upsert",
    agent: input.agent,
    item: `options-refused:${input.at}`,
    draft: {
      type: "notice",
      level: "info",
      code: "execution_option_refused",
      text: `This agent didn't take ${named.join(" or ")}, so it runs at its default.`,
      complete: true,
    },
  };
}

/** The transcript line for a live session stopped because its parent's access tightened. */
export function ceilingStoppedNotice(input: { agent: string; at: number }): Fact {
  return {
    type: "item.upsert",
    agent: input.agent,
    item: `access-ceiling-stopped:${input.at}`,
    draft: {
      type: "notice",
      level: "warning",
      code: "access_ceiling_stopped",
      text: "Stopped: its parent's access changed, and this agent can't run with anything that strict.",
      complete: true,
    },
  };
}
