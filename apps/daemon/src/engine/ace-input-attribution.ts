import { z } from "zod";
import { DelegationOutcome } from "@ace/protocol";
import type { Fact } from "@ace/core";

export const AceInput = z.object({
  agent: z.string(),
  item: z.string(),
  results: z.array(DelegationOutcome).max(64),
});
export type AceInput = z.infer<typeof AceInput>;

/** Native content cannot establish origin; only the host's persisted command can. */
export function settledInputEcho(source: AceInput | undefined, fact: Fact): Fact {
  if (
    !source ||
    (fact.type !== "item.upsert" && fact.type !== "item.reconciled") ||
    fact.draft.type !== "message" ||
    fact.draft.role !== "user" ||
    fact.agent !== source.agent
  )
    return fact;
  return {
    type: "item.upsert",
    agent: source.agent,
    item: source.item,
    draft: {
      type: "delegation.settled",
      complete: true,
      results: source.results,
      delivery: "ace-input",
      origin: "ace",
      ...(fact.draft.raw ? { raw: fact.draft.raw } : {}),
    },
  };
}
