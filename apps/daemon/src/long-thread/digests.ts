import { z } from "zod";
import { TurnDigest, ToolKind, type Event } from "@ace/protocol";
import { emptyTurnDigest, digestFromCounters, type DigestContribution } from "@ace/projection";
import { LongThreadDatabase, decodeCounters, type Counters } from "./database.ts";

const FileRow = z.object({
  path: z.string(),
  added: z.number(),
  removed: z.number(),
  unknown: z.number(),
  refs: z.number(),
});
const ItemFile = z.object({
  path: z.string(),
  added: z.number().nullable(),
  removed: z.number().nullable(),
  ordinal: z.number(),
});
const Command = TurnDigest.shape.commands.element;

export class Digests {
  private readonly data: LongThreadDatabase;
  constructor(data: LongThreadDatabase) {
    this.data = data;
  }
  bump(event: Event, ordinal: number, key: string, delta: number): void {
    if (!delta) return;
    const update = this.data.sql(
      `INSERT INTO long_counts VALUES(?,?,?,?) ON CONFLICT(thread_id,ordinal,key) DO UPDATE SET value=MAX(0,MIN(9007199254740991,value+excluded.value)) RETURNING value`,
    );
    update.get(event.threadId, ordinal, key, delta);
    if (key.startsWith("live:")) return;
    const value = Number(update.get(event.threadId, 0, key, delta)?.value);
    this.data.run(
      `INSERT INTO long_prefix VALUES(?,?,?,?,?) ON CONFLICT(thread_id,key,seq) DO UPDATE SET value=excluded.value`,
      event.threadId,
      key,
      event.seq,
      event.at,
      value,
    );
  }
  replace(event: Event, ordinal: number, previous: Counters, next: Counters): void {
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]))
      this.bump(event, ordinal, key, (next[key] ?? 0) - (previous[key] ?? 0));
  }
  move(
    event: Event,
    oldOrdinal: number,
    ordinal: number,
    previous: Counters,
    next: Counters,
  ): void {
    if (oldOrdinal === ordinal) {
      this.replace(event, ordinal, previous, next);
      return;
    }
    for (const [key, value] of Object.entries(previous)) this.bump(event, oldOrdinal, key, -value);
    for (const [key, value] of Object.entries(next)) this.bump(event, ordinal, key, value);
  }
  counts(thread: string, ordinal: number): Counters {
    return Object.fromEntries(
      this.data
        .sql("SELECT key,value FROM long_counts WHERE thread_id=? AND ordinal=?")
        .all(thread, ordinal)
        .map((row) => [String(row.key), Number(row.value)]),
    );
  }
  agentReplace(
    event: Event,
    ordinal: number,
    agent: string,
    previous: Counters,
    next: Counters,
  ): void {
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const delta = (next[key] ?? 0) - (previous[key] ?? 0);
      if (delta)
        this.data.run(
          "INSERT INTO long_agent_counts VALUES(?,?,?,?,?) ON CONFLICT(thread_id,ordinal,agent_id,key) DO UPDATE SET value=MAX(0,MIN(9007199254740991,value+excluded.value))",
          event.threadId,
          ordinal,
          agent,
          key,
          delta,
        );
    }
  }
  readAgent(thread: string, ordinal: number, agent: string): TurnDigest {
    const counters = Object.fromEntries(
      this.data
        .sql(
          "SELECT key,value FROM long_agent_counts WHERE thread_id=? AND ordinal=? AND agent_id=?",
        )
        .all(thread, ordinal, agent)
        .map((row) => [String(row.key), Number(row.value)]),
    );
    const digest = digestFromCounters(counters);
    const files = this.data
      .sql(
        "SELECT path,added,removed,unknown,refs FROM long_agent_files WHERE thread_id=? AND ordinal=? AND agent_id=? ORDER BY path LIMIT 65",
      )
      .all(thread, ordinal, agent)
      .map((row) => FileRow.parse(row));
    digest.files = files.slice(0, 64).map((row) => ({
      path: row.path,
      added: row.unknown ? null : row.added,
      removed: row.unknown ? null : row.removed,
    }));
    const commands = this.data
      .sql(
        "SELECT c.data FROM long_commands c JOIN long_items i ON i.thread_id=c.thread_id AND i.item_id=c.item_id WHERE c.thread_id=? AND c.ordinal=? AND i.agent_id=? ORDER BY c.item_id LIMIT 65",
      )
      .all(thread, ordinal, agent);
    digest.commands = commands
      .slice(0, 64)
      .map((row) => Command.parse(JSON.parse(String(row.data))));
    digest.truncated = files.length > 64 || commands.length > 64;
    return TurnDigest.parse(digest);
  }
  rangeCounts(thread: string, seq: number): Counters {
    const current = this.counts(thread, 0);
    for (const key of Object.keys(current)) {
      const previous = this.data
        .sql(
          "SELECT value FROM long_prefix WHERE thread_id=? AND key=? AND seq<=? ORDER BY seq DESC LIMIT 1",
        )
        .get(thread, key, seq);
      current[key] = Math.max(0, (current[key] ?? 0) - Number(previous?.value ?? 0));
    }
    return current;
  }
  private file(
    event: Event,
    ordinal: number,
    path: string,
    added: number | null,
    removed: number | null,
    sign: number,
    agent?: string,
  ): void {
    for (const target of [ordinal, 0]) {
      this.data.run(
        `INSERT INTO long_files VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,ordinal,path) DO UPDATE SET added=added+excluded.added,removed=removed+excluded.removed,unknown=unknown+excluded.unknown,refs=refs+excluded.refs,last_seq=excluded.last_seq`,
        event.threadId,
        target,
        path,
        (added ?? 0) * sign,
        (removed ?? 0) * sign,
        Number(added === null || removed === null) * sign,
        sign,
        event.seq,
      );
      this.data.run(
        "DELETE FROM long_files WHERE thread_id=? AND ordinal=? AND path=? AND refs<=0",
        event.threadId,
        target,
        path,
      );
    }
    const value = this.data
      .sql(
        "SELECT added,removed,unknown FROM long_files WHERE thread_id=? AND ordinal=0 AND path=?",
      )
      .get(event.threadId, path);
    this.data.run(
      "INSERT INTO long_file_prefix VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,path,seq) DO UPDATE SET added=excluded.added,removed=excluded.removed,unknown=excluded.unknown",
      event.threadId,
      path,
      event.seq,
      Number(value?.added ?? 0),
      Number(value?.removed ?? 0),
      Number(value?.unknown ?? 0),
    );
    if (agent) {
      this.data.run(
        "INSERT INTO long_agent_files VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,ordinal,agent_id,path) DO UPDATE SET added=added+excluded.added,removed=removed+excluded.removed,unknown=unknown+excluded.unknown,refs=refs+excluded.refs,last_seq=excluded.last_seq",
        event.threadId,
        ordinal,
        agent,
        path,
        (added ?? 0) * sign,
        (removed ?? 0) * sign,
        Number(added === null || removed === null) * sign,
        sign,
        event.seq,
      );
      this.data.run(
        "DELETE FROM long_agent_files WHERE thread_id=? AND ordinal=? AND agent_id=? AND path=? AND refs<=0",
        event.threadId,
        ordinal,
        agent,
        path,
      );
    }
  }
  itemDetails(
    event: Event,
    ordinal: number,
    itemId: string,
    contribution: DigestContribution,
    agent?: string,
  ): void {
    const oldAgent = this.data
      .sql("SELECT agent_id FROM long_items WHERE thread_id=? AND item_id=?")
      .get(event.threadId, itemId)?.agent_id;
    for (const value of this.data
      .sql("SELECT path,added,removed,ordinal FROM long_item_files WHERE thread_id=? AND item_id=?")
      .iterate(event.threadId, itemId)) {
      const old = ItemFile.parse(value);
      this.file(
        event,
        old.ordinal,
        old.path,
        old.added,
        old.removed,
        -1,
        oldAgent == null ? undefined : String(oldAgent),
      );
    }
    this.data.run(
      "DELETE FROM long_item_files WHERE thread_id=? AND item_id=?",
      event.threadId,
      itemId,
    );
    const files = new Map<string, TurnDigest["files"][number]>();
    for (const value of contribution.files) {
      const old = files.get(value.path);
      files.set(value.path, {
        path: value.path,
        added: old?.added === null || value.added === null ? null : (old?.added ?? 0) + value.added,
        removed:
          old?.removed === null || value.removed === null
            ? null
            : (old?.removed ?? 0) + value.removed,
      });
    }
    for (const value of files.values()) {
      this.data.run(
        "INSERT INTO long_item_files VALUES(?,?,?,?,?,?)",
        event.threadId,
        itemId,
        value.path,
        ordinal,
        value.added,
        value.removed,
      );
      this.file(event, ordinal, value.path, value.added, value.removed, 1, agent);
    }
    this.data.run(
      "DELETE FROM long_commands WHERE thread_id=? AND item_id=?",
      event.threadId,
      itemId,
    );
    for (const command of contribution.commands)
      for (const target of [ordinal, 0])
        this.data.run(
          "INSERT INTO long_commands VALUES(?,?,?,?,?)",
          event.threadId,
          target,
          itemId,
          JSON.stringify(command),
          event.seq,
        );
  }
  read(thread: string, ordinal: number, since?: number): TurnDigest {
    const counters =
      since === undefined ? this.counts(thread, ordinal) : this.rangeCounts(thread, since);
    const digest = emptyTurnDigest();
    for (const kind of ToolKind.options)
      if (counters[`tool:${kind}`])
        Object.defineProperty(digest.toolCounts, kind, {
          value: counters[`tool:${kind}`],
          enumerable: true,
        });
    for (const key of [
      "commandsRun",
      "commandsFailed",
      "approvalsAsked",
      "approvalsAnswered",
      "approvalsAutoReviewed",
      "subagentsStarted",
      "subagentsFinished",
      "errors",
    ] as const)
      digest[key] = counters[key] ?? 0;
    // Pending approvals describe the current state, including requests opened before the boundary.
    digest.approvalsPending = this.counts(thread, ordinal).approvalsPending ?? 0;
    if (this.counts(thread, ordinal).tokenSamples) {
      digest.inputTokens = counters.inputTokens ?? 0;
      digest.outputTokens = counters.outputTokens ?? 0;
    }
    const files = this.data
      .sql(
        "SELECT path,added,removed,unknown,refs FROM long_files WHERE thread_id=? AND ordinal=? AND last_seq>? ORDER BY last_seq,path LIMIT 65",
      )
      .all(thread, ordinal, since ?? -1)
      .map((row) => FileRow.parse(row));
    digest.files = files.slice(0, 64).map((row) => {
      const previous =
        since === undefined
          ? undefined
          : this.data
              .sql(
                "SELECT added,removed,unknown FROM long_file_prefix WHERE thread_id=? AND path=? AND seq<=? ORDER BY seq DESC LIMIT 1",
              )
              .get(thread, row.path, since);
      const unknown = row.unknown - Number(previous?.unknown ?? 0) > 0;
      return {
        path: row.path,
        added: unknown ? null : Math.max(0, row.added - Number(previous?.added ?? 0)),
        removed: unknown ? null : Math.max(0, row.removed - Number(previous?.removed ?? 0)),
      };
    });
    const commands = this.data
      .sql(
        "SELECT data FROM long_commands WHERE thread_id=? AND ordinal=? AND last_seq>? ORDER BY last_seq,item_id LIMIT 65",
      )
      .all(thread, ordinal, since ?? -1);
    digest.commands = commands
      .slice(0, 64)
      .map((row) => Command.parse(JSON.parse(String(row.data))));
    digest.truncated = files.length > 64 || commands.length > 64;
    return TurnDigest.parse(digest);
  }
  entity(
    event: Event,
    kind: string,
    id: string,
    ordinal: number,
    counters: Counters,
    data: unknown,
  ): void {
    const old = this.data
      .sql("SELECT ordinal,counters FROM long_entities WHERE thread_id=? AND kind=? AND id=?")
      .get(event.threadId, kind, id);
    this.move(
      event,
      old ? Number(old.ordinal) : ordinal,
      ordinal,
      old ? decodeCounters(old.counters) : {},
      counters,
    );
    const owner = z.object({ agentId: z.string() }).safeParse(data);
    if (owner.success)
      this.agentReplace(
        event,
        ordinal,
        owner.data.agentId,
        old ? decodeCounters(old.counters) : {},
        counters,
      );
    this.data.run(
      `INSERT INTO long_entities VALUES(?,?,?,?,?,?,?) ON CONFLICT(thread_id,kind,id) DO UPDATE SET ordinal=excluded.ordinal,counters=excluded.counters,data=excluded.data,last_seq=excluded.last_seq`,
      event.threadId,
      kind,
      id,
      ordinal,
      JSON.stringify(counters),
      JSON.stringify(data),
      event.seq,
    );
  }
}
