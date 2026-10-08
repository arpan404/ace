import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { normalizeAceCall, redactAceApproval } from "@ace/core";
import type { Fact } from "@ace/core";
import type { RawPayload, ToolCall } from "@ace/protocol";

/** Snapshot facts use the same cap as Store events, including existing blob refs. */
export function capFact(
  capRaw: (raw: RawPayload[]) => RawPayload[],
  fact: Fact,
  previous?: ToolCall,
): Fact {
  if (fact.type === "interaction.opened") {
    const request = redactAceApproval(fact.request);
    if (request !== fact.request)
      fact = { ...fact, request, raw: [{ type: "ace.private-input", data: { redacted: true } }] };
  }
  if (
    (fact.type === "item.upsert" || fact.type === "item.reconciled") &&
    fact.draft.type === "tool_call" &&
    fact.draft.call
  )
    fact = { ...fact, draft: { ...fact.draft, call: normalizeAceCall(fact.draft.call, previous) } };
  if (
    (fact.type === "item.upsert" || fact.type === "item.reconciled") &&
    fact.draft.type === "tool_call" &&
    fact.draft.call?.raw
  )
    return {
      ...fact,
      draft: { ...fact.draft, call: { ...fact.draft.call, raw: capRaw(fact.draft.call.raw) } },
    };
  if (
    (fact.type === "item.upsert" || fact.type === "item.reconciled") &&
    "raw" in fact.draft &&
    fact.draft.raw
  )
    return { ...fact, draft: { ...fact.draft, raw: capRaw(fact.draft.raw) } };
  if ((fact.type === "interaction.opened" || fact.type === "background.started") && fact.raw)
    return { ...fact, raw: capRaw(fact.raw) };
  return fact;
}
export function readRawBlob(db: DatabaseSync, id: string): Uint8Array | undefined {
  const key = z.string().min(1).parse(id);
  // Keep pre-ADR-0006 engine envelopes readable after upgrade.
  const row =
    db.prepare("SELECT bytes FROM blobs WHERE id=?").get(key) ??
    db.prepare("SELECT bytes FROM engine_raw_blobs WHERE id=?").get(key);
  const value = row?.bytes;
  if (value === undefined) return undefined;
  if (!(value instanceof Uint8Array)) throw new Error("Invalid stored raw blob");
  return value;
}
