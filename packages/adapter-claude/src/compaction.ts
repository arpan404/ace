import type { ClaudeState } from "./state.ts";
import { list, object, raw, string, type Data } from "./native.ts";

/*
 * Claude Code's context compaction. While it compacts, `system/status` says `compacting` (the
 * translator's activity). When it finishes it writes `system/compact_boundary`, then the summary
 * the model continues from as the next user turn: in stream-json a `user` frame marked only
 * `isSynthetic` (the transcript file marks it `isCompactSummary`, which newer CLIs may forward).
 * That summary is provider-internal text: it folds into the compaction's own item, never a
 * message of its own. Both frames are keyed by their uuid, so a redelivered one lands on the
 * same item instead of adding a second compaction or a message.
 */

const optionalCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** `system/compact_boundary`: the compaction's item, with the token counts Claude reports. */
export function compactBoundary(state: ClaudeState, data: Data, seq: number): void {
  const item = state.key("compact", string(data["uuid"]) || String(seq));
  // Delivered again: the item already holds it (and maybe its summary).
  if (state.compactions.has(item)) return;
  const meta = object(data["compact_metadata"]);
  const before = optionalCount(meta["pre_tokens"]);
  const after = optionalCount(meta["post_tokens"]);
  const boundary = raw(data);
  state.compactions.set(item, boundary);
  state.compaction = item;
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
 * main agent's synthetic turn right after a compaction, one Claude marks as a summary, or one
 * already folded and delivered again. Returns whether it did; any other frame of the main agent
 * ends the wait for a summary.
 */
export function compactSummary(state: ClaudeState, data: Data, seq: number): boolean {
  if (state.agentFor(data) !== state.root || data["type"] !== "user") {
    if (state.agentFor(data) === state.root) state.compaction = undefined;
    return false;
  }
  const uuid = string(data["uuid"]);
  const folded = uuid ? state.compactSummaries.get(uuid) : undefined;
  const pending = state.compaction;
  const eligible =
    folded !== undefined ||
    data["isCompactSummary"] === true ||
    (pending !== undefined && data["isSynthetic"] === true);
  const summary = eligible ? onlyText(data) : undefined;
  state.compaction = undefined;
  if (summary === undefined) return false;
  const item = folded ?? pending ?? state.key("compact", uuid || String(seq));
  if (uuid) state.compactSummaries.set(uuid, item);
  const boundary = state.compactions.get(item);
  state.emit({
    type: "item.upsert",
    agent: state.root,
    item,
    draft: {
      type: "compaction",
      complete: true,
      summary,
      raw: [...(boundary ? [boundary] : []), raw(data)],
    },
  });
  return true;
}
