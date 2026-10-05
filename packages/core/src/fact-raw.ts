import type { Fact } from "./facts.ts";
import type { RawPayload } from "@ace/protocol";

/** Native evidence carried by canonical adapter facts. */
export function factRaw(fact: Fact): RawPayload[] {
  if (fact.type === "item.upsert") {
    if (fact.draft.type === "tool_call") return fact.draft.call?.raw ?? [];
    if (
      fact.draft.type === "message" ||
      fact.draft.type === "notice" ||
      fact.draft.type === "reasoning"
    )
      return fact.draft.raw ?? [];
  }
  if (fact.type === "interaction.opened" || fact.type === "background.started")
    return fact.raw ?? [];
  return [];
}
