import type { ClaudeState } from "./state.ts";
import { list, object, raw, string, type Data } from "./native.ts";

/*
 * Claude Code's context compaction. While it compacts, `system/status` says `compacting` (the
 * translator's activity). When it finishes it writes `system/compact_boundary`, then the summary
 * the model continues from as the next user turn: in stream-json a `user` frame marked only
 * `isSynthetic` (the transcript file marks it `isCompactSummary`, which newer CLIs may forward).
 * That summary is provider-internal text: it folds into the compaction's own item, never a
 * message of its own.
 */

const optionalCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** `system/compact_boundary`: the compaction's item, with the token counts Claude reports. */
export function compactBoundary(state: ClaudeState, data: Data, seq: number): void {
  const meta = object(data["compact_metadata"]);
  const before = optionalCount(meta["pre_tokens"]);
  const after = optionalCount(meta["post_tokens"]);
  const item = state.key("compact", String(seq));
  const boundary = raw(data);
  state.compaction = { item, raw: boundary };
  state.emit({
    type: "item.upsert",
    agent: state.root,
    item,
    draft: {
      type: "compaction",
      complete: true,
      ...(before === undefined ? {} : { tokensBefore: before }),
      ...(after === undefined ? {} : { tokensAfter: after }),
      raw: [boundary],
    },
  });
}

/** The text of a user frame that carries only text, or undefined (tool results, images). */
function onlyText(data: Data): string | undefined {
  const content = object(data["message"])["content"];
  if (typeof content === "string") return content || undefined;
  const blocks = list(content).map(object);
  if (!blocks.length || blocks.some((block) => block["type"] !== "text")) return undefined;
  const text = blocks.map((block) => string(block["text"])).join("");
  return text || undefined;
}

/**
 * Folds a received user frame into the compaction it summarizes, when it is that summary: the
 * main agent's synthetic turn right after a compaction, or one Claude marks as a summary.
 * Returns whether it did; any other frame of the main agent ends the wait for a summary.
 */
export function compactSummary(state: ClaudeState, data: Data, seq: number): boolean {
  if (state.agentFor(data) !== state.root) return false;
  const pending = state.compaction;
  const marked = data["isCompactSummary"] === true;
  const summary =
    data["type"] === "user" && (marked || (pending && data["isSynthetic"] === true))
      ? onlyText(data)
      : undefined;
  state.compaction = undefined;
  if (summary === undefined) return false;
  state.emit({
    type: "item.upsert",
    agent: state.root,
    item: pending?.item ?? state.key("compact", string(data["uuid"], String(seq))),
    draft: {
      type: "compaction",
      complete: true,
      summary,
      raw: [...(pending ? [pending.raw] : []), raw(data)],
    },
  });
  return true;
}
