import type { Fact } from "@ace/core";
import { inheritedDrafts } from "@ace/handoff";
import type { AgentId, Item, ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { EngineRepository } from "./repository.ts";
import { boundary } from "./transition-history.ts";

/** The newest messages a fork copies; a note says when older ones stayed in the source. */
export const maxInheritedMessages = 200;
/** A copied message keeps at most this much of its text (UTF-16 bytes), then says it was cut. */
export const maxInheritedTextBytes = 64 * 1024;
const pageBytes = 1024 * 1024;

const heads = z.array(z.object({ created_seq: z.number().int().positive() }));

/**
 * Where the forked agent's messages were created, newest `maxInheritedMessages` (plus one, to
 * tell whether older ones exist), read from the item index rather than every item.
 */
function messageSeqs(repo: EngineRepository, source: ThreadId, through: number, agent: AgentId) {
  return heads.parse(
    repo.store.atomic((db) =>
      db
        .prepare(
          `SELECT created_seq FROM item_heads WHERE thread_id=? AND agent_id=? AND created_seq<=?
          AND item_type='message' ORDER BY created_seq DESC LIMIT ?`,
        )
        .all(source, agent, through, maxInheritedMessages + 1),
    ),
  );
}

/** A message as the source held it at the fork point, its text read whole up to the budget. */
function messageAt(repo: EngineRepository, source: ThreadId, through: number, seq: number) {
  const item = repo.store.readBoundedHistoricalItemPage(source, through, seq + 1, 1, pageBytes)
    .items[0];
  if (item?.type !== "message") return undefined;
  const parts = item.parts.map((part) => {
    if (part.type !== "text" || !part.source || part.source.bytes <= part.text.length * 2)
      return part;
    const read = repo.store.readHistoricalStream(
      source,
      part.source.streamId,
      through,
      0,
      Math.min(part.source.bytes, maxInheritedTextBytes),
    );
    return { ...part, text: read.bytes.toString("utf16le") };
  });
  return { ...item, parts } satisfies Item;
}

/**
 * The facts that open a fork on the conversation it continues: copies of the source agent's
 * asks and answers through the fork point, each marked with where and when it was said. A cold
 * operation run once when the fork is made (or when a switch drops a native fork that would
 * have brought them along): one indexed query, then one bounded read per message.
 */
export function forkHistoryFacts(
  repo: EngineRepository,
  source: ThreadId,
  point: { throughSeq: number; parentAgentId: AgentId },
): Fact[] {
  const seqs = messageSeqs(repo, source, point.throughSeq, point.parentAgentId);
  const trimmed = seqs.length > maxInheritedMessages;
  const items = seqs
    .slice(0, maxInheritedMessages)
    .toReversed()
    .flatMap((row) => messageAt(repo, source, point.throughSeq, row.created_seq) ?? []);
  return inheritedDrafts(items, point.parentAgentId, source, trimmed).map(({ key, draft }) => ({
    type: "item.upsert",
    agent: "root",
    item: key,
    draft,
  }));
}

/**
 * The copies for a fork made natively on a provider that brings the source's turns along
 * itself, which leaves that path before its session opened (a switch to another provider or
 * account): nothing would show its history otherwise. None when the source is gone.
 */
export function lateForkHistoryFacts(repo: EngineRepository, fork: ThreadId): Fact[] {
  const lineage = repo.store.getThread(fork)?.lineage;
  if (!lineage || !repo.state(lineage.parentThreadId)) return [];
  return forkHistoryFacts(
    repo,
    lineage.parentThreadId,
    boundary(repo, lineage.parentThreadId, lineage.point),
  );
}
