import type { ThreadSource } from "@ace/client";
import { RunId, type Attachment, type ForkPoint, type Item } from "@ace/protocol";
import {
  editPointOf,
  forkPointOf,
  bringBackOf,
  latestForkPoint,
  resendInput,
  retryPointOf,
  type RetryPoint,
} from "@ace/ui-core";

/*
 * What a message's action row offers, by the shared rules (`@ace/ui-core` fork, edit and retry
 * points), so Swift only lays the buttons out: Fork from an answer of the main agent once its turn
 * has finished, Edit on the person's message when a finished answer comes before it, Rewind on
 * Pi's own answers. A control that can't act is never sent. Pure over the reader.
 */

type Message = Extract<Item, { type: "message" }>;

/** An answer Pi wrote, or one with no recorded source on a Pi thread. */
function piWrote(store: ThreadSource, item: Message): boolean {
  return (item.executionSource?.selection.provider ?? store.thread?.provider) === "pi";
}

/** The row's actions beyond Copy: what each button would do, never whether it is busy. */
export function messageActionsOf(store: ThreadSource, item: Item, at?: number) {
  const root = store.thread?.rootAgentId;
  if (item.type !== "message" || !root || item.synthetic) return undefined;
  const mine = item.agentId === root || item.agentId === undefined;
  if (item.role === "user") {
    const index = at !== undefined && store.order[at] === item.id ? at : undefined;
    return {
      fork: false,
      edit: editPointOf(store, item.id, root, index) !== undefined,
      rewind: false,
    };
  }
  if (item.role !== "assistant" || !mine) return undefined;
  const fork =
    forkPointOf(item, item.runId === undefined ? undefined : store.run(item.runId)) !== undefined;
  return {
    fork,
    edit: false,
    rewind: fork && item.nativeId !== undefined && piWrote(store, item),
  };
}

/** What a message's actions start from: an answer, the newest turn, or a message to edit. */
export type ForkAt =
  | { kind: "answer"; itemId: string; runId?: string | undefined }
  | { kind: "latest" }
  | { kind: "edit"; itemId: string };

export interface ForkStart {
  point: ForkPoint;
  /** Where the fork starts, as the composer's strip names it. */
  from: string;
  /** The words the composer starts with: the person's message when it is edited. */
  prefill: string;
  /** The edited message's stored files, carried onto the fork's first message by reference. */
  carry?: { itemId: string; files: readonly Attachment[] } | undefined;
}

const words = (item: Item | undefined) =>
  resendInput(item)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

/** One line of a message for the strip: its opening words. */
function opening(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Where a fork asked for at `at` starts, in `stores` (the live tail first, then the history window
 * the person reads). An answer only the history window holds starts from the turn its row names:
 * its turn has long finished, and the daemon checks the point again.
 */
export function forkStart(
  stores: readonly ThreadSource[],
  at: ForkAt,
): ForkStart | { refused: string } {
  const live = stores[0];
  const root = live?.thread?.rootAgentId;
  if (!live || !root) return { refused: "Still reading this thread. Try again." };
  if (at.kind === "latest") {
    const point = latestForkPoint(live, root);
    return point
      ? { point, from: "the last turn", prefill: "" }
      : { refused: "Wait for a turn to finish before forking." };
  }
  const store = stores.find((candidate) => candidate.item(at.itemId) !== undefined);
  const item = store?.item(at.itemId);
  if (at.kind === "edit") {
    const point = store && editPointOf(store, at.itemId, root);
    if (!point) return { refused: "There is no earlier answer to continue from." };
    const text = words(item);
    const files = item?.type === "message" ? (item.attachments ?? []) : [];
    return {
      point: point.fork,
      from: `before “${opening(text)}”`,
      prefill: text,
      ...(files.length ? { carry: { itemId: at.itemId, files } } : {}),
    };
  }
  const point = store
    ? forkPointOf(item, item?.runId === undefined ? undefined : store.run(item.runId))
    : undefined;
  const from = item?.type === "message" ? `“${opening(words(item))}”` : "this answer";
  if (point) return { point, from, prefill: "" };
  if (!item && at.runId)
    return { point: { type: "turn", runId: RunId.parse(at.runId) }, from, prefill: "" };
  return { refused: "Wait for this turn to finish before forking from it." };
}

/**
 * The open thread's transitions: which answer Retry sits under (Pi, the newest), whether Pi can
 * go back now (every agent finished), whether the last turn can be forked, and the parent a fork
 * brings its work back to.
 */
export function transitionsRow(store: ThreadSource) {
  const thread = store.thread;
  const root = thread?.rootAgentId;
  const state = thread?.status.state;
  const settled = state === "done" || state === "failed";
  const pi = thread?.provider === "pi";
  const retry = pi && settled ? newestRetry(store, root) : undefined;
  const parent = thread?.lineage?.parentThreadId;
  return {
    pi,
    settled,
    retry: retry ? { answerId: retry.answerId, askId: retry.point.askId } : null,
    lastTurn: latestForkPoint(store, root) !== undefined,
    parent: parent
      ? { threadId: parent, ready: "answer" in bringBackOf(store, root, state) }
      : null,
  };
}

/** The newest answer Retry can ask again, with Pi's entry to go back to. */
function newestRetry(
  store: ThreadSource,
  root: string | undefined,
): { answerId: string; point: RetryPoint } | undefined {
  for (let at = store.order.length - 1; at >= 0; at--) {
    const item = store.item(store.order[at] ?? "");
    if (item?.type !== "message" || item.agentId !== root) continue;
    if (item.role !== "assistant") return undefined;
    const point = retryPointOf(store, item.id, root);
    return point?.point.piEntry ? { answerId: item.id, point } : undefined;
  }
  return undefined;
}
