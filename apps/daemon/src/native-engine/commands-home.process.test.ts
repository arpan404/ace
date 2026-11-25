// SPDX-License-Identifier: Apache-2.0
/**
 * E5.4a's seam tests on homes the TypeScript engine wrote. Each runs only with the switch on and
 * names the (a) test that replaces it:
 *
 * - queue reads: `queue-context.process` `:15`.
 * - `commandFailure`/`commandExecution`: `input-fate.process` `:38`.
 * - stale retirement: `stale-inputs.process` `:47`.
 *
 * The seed is a second process (`testing/commands-home.ts`), so the real edge is a TypeScript
 * writer and a native reader over the same SQLite file.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CommandId } from "@ace/protocol";
import { engineBackend } from "@ace/provider-kit/native-switches";
import type { Store } from "../store.ts";
import { engineSeam, type EngineSeam } from "./testing.ts";

const native = engineBackend() === "native";
const child = join(fileURLToPath(new URL(".", import.meta.url)), "testing/commands-home.ts");

/** The seeded threads, oldest first. */
function threads(store: Store): string[] {
  return (
    store.atomic((db) => db.prepare("SELECT id FROM threads ORDER BY rowid").all()) as {
      id: string;
    }[]
  ).map((row) => row.id);
}

function queueUpdated(store: Store, id: string): number {
  const row = store.atomic((db) =>
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE thread_id=? AND type='queue.updated'")
      .get(id),
  ) as { n: number };
  return Number(row.n);
}

async function seeded(): Promise<{ seam: EngineSeam; queue: string; stale: string }> {
  const seam = await engineSeam({ seedWithTypeScript: { script: child } });
  const [queue, stale] = threads(seam.store) as [string, string];
  return { seam, queue, stale };
}

describe.runIf(native)("E5.4a queue reads on a TypeScript-written home", () => {
  test("a queue the TypeScript engine wrote reads the same natively: snapshot, first page, next page, total", async () => {
    const { seam, queue } = await seeded();
    try {
      const snapshot = seam.engine.queue(queue as never);
      expect(snapshot).toMatchObject({
        pendingCount: 4,
        revision: 1,
        paused: true,
        reason: "stopped",
      });
      expect(snapshot.messages.map((message) => message.id)).toEqual([
        "queued-a",
        "queued-b",
        "steer-fellback",
        "uncertain",
      ]);
      const fellBack = snapshot.messages.find((message) => message.id === "steer-fellback");
      expect(fellBack).toMatchObject({ delivery: "queue", state: "queued", fellBack: true });
      const uncertain = snapshot.messages.find((message) => message.id === "uncertain");
      expect(uncertain).toMatchObject({
        state: "uncertain",
        input: [{ type: "text", text: "maybe ran" }],
      });
      expect("exited" in snapshot).toBe(false);
      // A child result is ace's input, never in the person's queue.
      expect(snapshot.messages.some((message) => message.id === "child-result")).toBe(false);

      const first = seam.engine.queuePage({ threadId: queue as never, limit: 2 });
      expect(first.messages.map((message) => message.id)).toEqual(["queued-a", "queued-b"]);
      expect(first.total).toBe(4);
      expect(first.next).toBe("queued-b");
      const next = seam.engine.queuePage({
        threadId: queue as never,
        after: first.next ?? undefined,
        expectedRevision: first.revision,
        limit: 2,
      });
      expect(next.messages.map((message) => message.id)).toEqual(["steer-fellback", "uncertain"]);
      expect(next.next).toBeNull();
    } finally {
      await seam.close();
    }
  });

  test("a page refuses a stale revision, a cursor without a revision and an unknown cursor, with the TypeScript messages", async () => {
    const { seam, queue } = await seeded();
    try {
      const snapshot = seam.engine.queue(queue as never);
      expect(() =>
        seam.engine.queuePage({
          threadId: queue as never,
          after: CommandId.parse("queued-a"),
          expectedRevision: snapshot.revision + 1,
        }),
      ).toThrow("queue_conflict");
      expect(() =>
        seam.engine.queuePage({ threadId: queue as never, after: CommandId.parse("queued-a") }),
      ).toThrow("queue_revision_required");
      expect(() =>
        seam.engine.queuePage({
          threadId: queue as never,
          after: CommandId.parse("missing"),
          expectedRevision: snapshot.revision,
        }),
      ).toThrow("invalid_queue_cursor");
    } finally {
      await seam.close();
    }
  });

  test("commandFailure and commandExecution read a removed, a cancelled and a done intent", async () => {
    const { seam } = await seeded();
    try {
      expect(seam.engine.commandFailure("removed-one" as never)).toBe("Removed from queue");
      expect(seam.engine.commandExecution("removed-one" as never)).toBe("failed");
      expect(seam.engine.commandFailure("cancelled-one" as never)).toBe(
        "Cancelled before delivery",
      );
      expect(seam.engine.commandExecution("cancelled-one" as never)).toBe("failed");
      expect(seam.engine.commandFailure("done-one" as never)).toBeUndefined();
      expect(seam.engine.commandExecution("done-one" as never)).toBe("done");
      expect(seam.engine.commandFailure("never-seen" as never)).toBeUndefined();
      expect(seam.engine.commandExecution("never-seen" as never)).toBeUndefined();
    } finally {
      await seam.close();
    }
  });

  test("a turn's end retires only the uncertain sends of its own session generation", async () => {
    const { seam, stale } = await seeded();
    try {
      const before = queueUpdated(seam.store, stale);
      seam.probe.inputFacts("retireEndedTurnInputs", {
        thread: stale,
        generation: 2,
        at: 50,
      });
      // Generation 2's send is retired; generation 1's stays and still holds the queue.
      expect(queueUpdated(seam.store, stale) - before).toBe(1);
      expect(seam.engine.queue(stale as never)).toMatchObject({
        paused: true,
        reason: "uncertain",
      });
      expect(seam.engine.queue(stale as never).messages.map((message) => message.id)).toEqual([
        "gen-one",
      ]);

      seam.probe.inputFacts("retireEndedTurnInputs", {
        thread: stale,
        generation: 1,
        at: 60,
      });
      expect(queueUpdated(seam.store, stale) - before).toBe(2);
      expect(seam.engine.queue(stale as never)).toMatchObject({
        paused: false,
        reason: null,
        messages: [],
      });
    } finally {
      await seam.close();
    }
  });
});
