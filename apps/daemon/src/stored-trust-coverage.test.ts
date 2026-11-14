import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentId, AgentItem, ItemId, type Event, type ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { message, shell } from "./payload-test-support.ts";
import { Store } from "./store.ts";

/*
 * Every kind of stored row a read trusts by a sequence (`isTrusted` in stored-decode.ts), planted
 * at an old sequence in a form validation would change or reject, where the row is not the one
 * the event at that sequence names: another item's revision or chunk, or a row whose event is
 * gone. After the idle pass, every read must still give what a store that trusts nothing gives.
 * A new trusted read adds its row kind here.
 */

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const root = AgentId.parse("root");
const live = AgentItem.parse({
  id: "live",
  agentId: "root",
  type: "message",
  role: "assistant",
  complete: false,
  createdAt: 1,
  parts: [],
});

interface Written {
  thread: ThreadId;
  /** The `item.created` event of each item, by item id. */
  created: Map<string, Event>;
  /** Sequences of events that wrote no item rows: other threads' creation. */
  bare: number[];
}

/** A thread with finished messages, a tool call, and a message still streaming. */
function write(store: Store): Written {
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(store, workspace).id;
  // Two more threads, whose creation events write no item rows.
  const before = store.headSeq();
  createDevThread(store, workspace, "Spare one");
  createDevThread(store, workspace, "Spare two");
  const bare = [before + 1, before + 2];
  const created = new Map<string, Event>();
  const add = (item: ReturnType<typeof message>) => {
    const [event] = store.appendEvents(thread, [{ type: "item.created", item }]);
    if (!event) throw new Error("nothing appended");
    created.set(item.id, event);
  };
  for (let index = 0; index < 10; index++) add(message(`m${index}`, `text ${index}`));
  add({ ...shell("tool"), complete: true });
  add(live);
  for (const append of ["Hel", "lo"])
    store.appendEvents(thread, [
      { type: "item.delta", itemId: ItemId.parse("live"), agentId: root, field: "text", append },
    ]);
  return { thread, created, bare };
}

type Run = (statement: string, ...values: (string | number)[]) => void;
const seqOf = (written: Written, id: string) => {
  const event = written.created.get(id);
  if (!event) throw new Error(`no ${id}`);
  return event.seq;
};
/** Move `agentId` to the end of a stored item: a raw rewrite validation puts back in order. */
const agentLast = (column: string) =>
  `json_set(json_remove(${column}, '$.agentId'), '$.agentId', json_extract(${column}, '$.agentId'))`;

const cases: { kind: string; plant: (run: Run, written: Written) => void }[] = [
  {
    kind: "another item's history revision at an event's sequence",
    plant: (run, written) =>
      // m7's earliest completed revision, planted at m2's sequence, out of field order.
      run(
        `INSERT INTO history_item_revisions SELECT item_id, ?, ${agentLast("item")} FROM history_item_revisions WHERE item_id = 'm7'`,
        seqOf(written, "m2"),
      ),
  },
  {
    kind: "another item's streamed text chunk at an event's sequence",
    plant: (run, written) =>
      // A chunk of the streaming message at m2's sequence, its append not a JSON string.
      run("INSERT INTO item_text_chunks VALUES ('live', ?, 'text', '5')", seqOf(written, "m2")),
  },
  {
    kind: "an item body whose event is gone",
    plant: (run, written) => {
      run(`UPDATE items SET item = ${agentLast("item")} WHERE id = 'tool'`);
      run("DELETE FROM events WHERE seq = ?", seqOf(written, "tool"));
    },
  },
  {
    kind: "a text preview whose item's event is gone",
    plant: (run, written) => {
      run(`UPDATE item_previews SET item = ${agentLast("item")} WHERE id = 'm4'`);
      run("DELETE FROM events WHERE seq = ?", seqOf(written, "m4"));
    },
  },
  {
    kind: "a history revision whose event is gone",
    plant: (run, written) => {
      // m5's earliest completed revision, out of field order, at a sequence with no other rows.
      const seq = written.bare[0] ?? 0;
      run(
        `INSERT INTO history_item_revisions SELECT item_id, ?, ${agentLast("item")} FROM history_item_revisions WHERE item_id = 'm5'`,
        seq,
      );
      run("DELETE FROM events WHERE seq = ?", seq);
    },
  },
  {
    kind: "a streamed text chunk whose event is gone",
    plant: (run, written) => {
      const seq = written.bare[1] ?? 0;
      run("DELETE FROM events WHERE seq = ?", seq);
      run("INSERT INTO item_text_chunks VALUES ('live', ?, 'text', '5')", seq);
    },
  },
  {
    kind: "an event an older layout left",
    plant: (run, written) =>
      run(
        "UPDATE events SET payload = json_remove(payload, '$.item.complete') WHERE seq = ?",
        seqOf(written, "m3"),
      ),
  },
];

/** What a read gives, or the error it throws. */
function outcome(read: () => unknown): unknown {
  try {
    return { value: read() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
/** Every trusted read of the thread: events, item pages, the wire page, completions, snapshot. */
function reads(store: Store, thread: ThreadId) {
  return {
    events: outcome(() => store.readEvents({ afterSeq: 0, limit: 10_000 })),
    items: outcome(() => store.readItems(thread, Number.MAX_SAFE_INTEGER, 200)),
    page: outcome(() => store.readItemPage(thread, Number.MAX_SAFE_INTEGER, 200)),
    completions: ["m2", "m5", "m7"].map((id) =>
      outcome(() => store.historicalItemCompletion(thread, ItemId.parse(id))),
    ),
    snapshot: outcome(() => store.snapshotThread(thread).items),
  };
}

for (const { kind, plant } of cases)
  it(`the idle pass leaves ${kind} on the validating path`, async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-trust-coverage-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const path = join(home, "events.sqlite");
    const open = (
      shape: string,
      build: string,
      extra: Partial<ConstructorParameters<typeof Store>[2]> = {},
    ) => {
      const store = new Store(path, console.error, {
        eventShape: shape,
        storedTrustBuild: build,
        ...extra,
      });
      cleanup.push(() => store.close());
      return store;
    };
    const writer = open("older build", "1.0.0");
    const written = write(writer);
    plant(
      (statement, ...values) => writer.atomic((db) => db.prepare(statement).run(...values)),
      written,
    );
    await writer.close();

    const pass: { tick?: () => void; finished: boolean } = { finished: false };
    const upgraded = open("this build", "2.0.0", {
      trustPass: {
        scheduler: (run) => {
          pass.tick = run;
          return () => {
            pass.finished = true;
          };
        },
      },
    });
    for (let guard = 0; !pass.finished && guard < 100; guard++) pass.tick?.();
    expect(pass.finished).toBe(true);
    const validating = open("this build", "another build", { storedTrustReader: true });
    // Serialised, so a difference in field order counts.
    expect(JSON.stringify(reads(upgraded, written.thread))).toBe(
      JSON.stringify(reads(validating, written.thread)),
    );
  });
