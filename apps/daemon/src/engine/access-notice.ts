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
