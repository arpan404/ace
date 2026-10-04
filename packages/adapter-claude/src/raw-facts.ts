import type { Fact } from "@ace/core";
import type { RawPayload } from "@ace/protocol";
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

// Receipt diagnostics own raw data; canonical enrichment must preserve prior raw.
export function canonicalOnly(fact: Fact): Fact {
  if (fact.type === "item.upsert") {
    if (fact.draft.type === "tool_call") {
      const call = { ...fact.draft.call };
      delete call.raw;
      return { ...fact, draft: { ...fact.draft, call } };
    }
    if (
      fact.draft.type === "message" ||
      fact.draft.type === "notice" ||
      fact.draft.type === "reasoning"
    ) {
      const draft = { ...fact.draft };
      delete draft.raw;
      return { ...fact, draft };
    }
  }
  if (fact.type === "interaction.opened" || fact.type === "background.started") {
    const canonical = { ...fact };
    delete canonical.raw;
    return canonical;
  }
  return fact;
}
