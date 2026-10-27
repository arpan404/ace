import { useMemo, useState } from "react";
import type { ThreadKey, ThreadReader, ThreadSource } from "@ace/client";
import { createBlockReader, type Watched } from "@ace/ui-core/transcript-block-reader";
import { blocksEqual, type Block } from "@ace/ui-core/transcript-blocks";
import { useSelection } from "./selection.ts";

export type { Block };

const baseKeys: readonly ThreadKey[] = [
  "order",
  "thread",
  "agents",
  "tasks",
  "interactions",
  "queue",
];
const noKeys: readonly ThreadKey[] = [];

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((key, index) => key === b[index]));
}

function sameReading(a: Watched<readonly Block[]>, b: Watched<readonly Block[]>): boolean {
  return blocksEqual(a.value, b.value) && sameList(a.watch, b.watch);
}

/**
 * Transcript blocks for one thread (A05.01).
 * Grouping comes from the shared `@ace/ui-core` block engine, never derived
 * locally: deltas update their own item row, membership only changes when the
 * order, tasks, interactions, agents, thread or queue change.
 *
 * Keys follow what the reader watched: the static base plus the run/agent/item
 * keys the last reading named, so a run ending or an agent settling re-runs the
 * reader without subscribing to streamed text. One reader serves one store: it
 * remembers turn keys and paused turns per thread, so switching threads starts
 * a fresh reader with no watch keys from the old one.
 */
export function useTranscriptBlocks(store: ThreadSource): readonly Block[] {
  // One reader serves one store: it remembers turn keys and paused turns per
  // thread. Render-phase reset (React-endorsed for previous-render info) so a
  // switched-to thread never inherits the old thread's grouping memory.
  const [held, setHeld] = useState(() => ({ store, read: createBlockReader() }));
  if (held.store !== store) setHeld({ store, read: createBlockReader() });
  const read = held.read;
  const owner = store.thread?.rootAgentId;
  const base = useMemo<readonly ThreadKey[]>(
    () => (owner ? [...baseKeys, `agent:${owner}`] : [...baseKeys]),
    [owner],
  );
  const [watch, setWatch] = useState<readonly ThreadKey[]>(noKeys);
  const [scoped, setScoped] = useState(store);
  if (scoped !== store) {
    setScoped(store);
    if (watch.length) setWatch(noKeys);
  }
  const keys = useMemo(() => [...base, ...watch], [base, watch]);
  const selection = useMemo(
    () => store.select(keys, (reader: ThreadReader) => read(reader), sameReading),
    [store, keys, read],
  );
  const reading = useSelection(selection);
  const next = reading.watch as readonly ThreadKey[];
  // Derived from the last reading: subscribing to new keys re-reads with them in place.
  if (!sameList(next, watch)) setWatch(next);
  return reading.value;
}

/** Stable list key for a block. */
export function blockKey(block: Block): string {
  return block.key;
}

/** Test identifier / accessibility label group for a block kind. */
export function blockTestId(block: Block): string {
  switch (block.kind) {
    case "user":
      return "transcript.user";
    case "message":
      return "transcript.answer";
    case "event":
      return "transcript.event";
    case "item":
      return "transcript.item";
    case "end":
      return `transcript.end.${block.ending}`;
    case "forked":
      return "transcript.forked";
    case "started":
      return "transcript.started";
    case "live":
      return "transcript.live";
    case "work":
      return "transcript.work";
    case "subagents":
      return "transcript.subagents";
    case "files":
      return "transcript.files";
    case "question":
      return "transcript.question";
  }
}

/**
 * Canonical wording for a turn-ending block, matching iOS/web wording:
 * a personal Stop is a thin "Interrupted by you" break, a restart is plain
 * "Interrupted", a failure reads "Turn failed", a usage-limit pause reads
 * "Paused".
 */
export function endBlockText(block: Extract<Block, { kind: "end" }>): string {
  if (block.ending === "interrupted") return block.automatic ? "Interrupted" : "Interrupted by you";
  if (block.ending === "paused") return "Paused — will resume";
  return "Turn failed";
}

/** Centered divider for a fork, naming the source thread when known. */
export function forkedBlockText(sourceThreadId: string, sourceTitle?: string): string {
  return sourceTitle ? `Forked from ${sourceTitle}` : "Forked from earlier conversation";
}

/** Quiet row for a thread the agent started where it was started. */
export function startedBlockText(title?: string): string {
  return title ? `Started ${title}` : "Started a new thread";
}
