// SPDX-License-Identifier: Apache-2.0
/**
 * The seam tests on homes the TypeScript engine wrote. Each runs only with the switch on and
 * names the (a) test that replaces it.
 *
 * E5.4a's reads (`testing/commands-home.ts`):
 *
 * - queue reads: `queue-context.process` `:15`.
 * - `commandFailure`/`commandExecution`: `input-fate.process` `:38`.
 * - stale retirement: `stale-inputs.process` `:47`.
 *
 * E5.4b's journal and run binding (`testing/inputs-home.ts`):
 *
 * - echo correlation: `late-admission.process` `:15`.
 * - a Claude command's first admission, and the Rust signature of it: `catalog-mentions.process`
 *   `:10`.
 * - run binding: `queued-run-binding.process` `:101`.
 *
 * The seed is a second process, so the real edge is a TypeScript writer and a native reader over
 * the same SQLite file.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { admissions as claudeAdmissions } from "@ace/adapter-claude/input";
import { CommandId, type ContentPart } from "@ace/protocol";
import { engineBackend } from "@ace/provider-kit/native-switches";
import type { Store } from "../store.ts";
import { engineSeam, type EngineSeam } from "./testing.ts";

const native = engineBackend() === "native";
const queueChild = join(fileURLToPath(new URL(".", import.meta.url)), "testing/commands-home.ts");
const inputsChild = join(fileURLToPath(new URL(".", import.meta.url)), "testing/inputs-home.ts");

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
  const seam = await engineSeam({ seedWithTypeScript: { script: queueChild } });
  const [queue, stale] = threads(seam.store) as [string, string];
  return { seam, queue, stale };
}

async function seededInputs(): Promise<{ seam: EngineSeam; thread: string }> {
  const seam = await engineSeam({ seedWithTypeScript: { script: inputsChild } });
  const rows = threads(seam.store);
  if (rows.length !== 1) throw new Error(`the seed wrote ${String(rows.length)} threads`);
  // E5.4's rounds do not recover threads (E5.8 does): the seam's ready settles its own refusal,
  // and these tests read the home through the probe either way.
  await seam.engine.ready().catch(() => {});
  return { seam, thread: rows[0]! };
}

/** One echo of a provider's user message. */
function echo(text: string, item = "native-item", extra: Record<string, unknown> = {}) {
  return {
    type: "item.upsert",
    agent: "root",
    item,
    draft: {
      type: "message",
      role: "user",
      parts: [{ type: "text", text }],
      ...extra,
    },
  };
}

describe.runIf(native)("E5.4a queue writes beside a store hook", () => {
  test("a write hook may re-enter the engine while the fold stages a queue update", async () => {
    const { seam, stale } = await seeded();
    try {
      const reentered: string[] = [];
      const stop = seam.store.onWrite(() => {
        // A state-taking engine read from the hook: before the fold released its borrow this
        // was Reentrant and failed the retirement. This thread has no stored state, so the
        // read itself answers with that, not the borrow.
        try {
          reentered.push(String(seam.engine.rootAgent(stale as never)));
        } catch (error) {
          reentered.push(String(error));
        }
      });
      try {
        seam.probe.inputFacts("retireEndedTurnInputs", {
          thread: stale,
          generation: 2,
          at: 70,
        });
      } finally {
        stop();
      }
      expect(reentered.length).toBeGreaterThan(0);
      expect(reentered.some((entry) => entry.includes("Reentrant"))).toBe(false);
      expect(seam.engine.queue(stale as never).messages.map((message) => message.id)).toEqual([
        "gen-one",
      ]);
    } finally {
      await seam.close();
    }
  });

  test("a hook that throws rolls the retirement back", async () => {
    const { seam, stale } = await seeded();
    try {
      const stop = seam.store.onWrite(() => {
        throw new Error("hook failed");
      });
      let failed = false;
      try {
        seam.probe.inputFacts("retireEndedTurnInputs", {
          thread: stale,
          generation: 2,
          at: 70,
        });
      } catch (error) {
        failed = String(error).includes("hook failed");
      } finally {
        stop();
      }
      expect(failed).toBe(true);
      // The clear the hook ran beside rolled back with the failed event write.
      expect(seam.engine.queue(stale as never).messages.map((message) => message.id)).toEqual([
        "gen-one",
        "gen-two",
      ]);
    } finally {
      await seam.close();
    }
  });
});

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

describe.runIf(native)("E5.4b input facts on a TypeScript-written home", () => {
  test("an echo correlates natively to the input the TypeScript engine sent: by native identity, by signature in its own generation, and not in another generation", async () => {
    const { seam, thread: id } = await seededInputs();
    try {
      // The negative case first: nothing is matched yet, so a miss is a real miss.
      const other = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo("two", "native-other"),
        generation: 7,
      });
      expect(other).toEqual(echo("two", "native-other"));

      const identity = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo("one", "native-item", { nativeId: "native-one" }),
        generation: 7,
      });
      expect(identity).toMatchObject({
        item: "input:gen-one",
        draft: {
          origin: { kind: "person", commandId: "gen-one" },
          synthetic: false,
        },
      });

      const own = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo("two"),
        generation: 8,
      });
      expect(own).toMatchObject({
        item: "input:gen-two",
        draft: { origin: { kind: "person", commandId: "gen-two" }, synthetic: false },
      });
    } finally {
      await seam.close();
    }
  });

  test("a Claude input with a slash command correlates by its first admission's text", async () => {
    const { seam, thread: id } = await seededInputs();
    try {
      const slash: ContentPart[] = [
        {
          type: "mention",
          entryId: "entry",
          kind: "command",
          name: "Review",
          arguments: "now",
          invocation: { type: "slash", name: "review" },
        },
        { type: "text", text: "look" },
      ];
      const first = claudeAdmissions(slash)[0];
      if (typeof first !== "string") throw new Error("the slash command is not one text admission");
      const correlated = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo(first),
        generation: 7,
      });
      expect(correlated).toMatchObject({
        item: "input:slash",
        draft: { origin: { kind: "person", commandId: "slash" }, synthetic: false },
      });
    } finally {
      await seam.close();
    }
  });

  test("a Claude command signed through the Rust journal correlates with its own echo", async () => {
    const { seam, thread: id } = await seededInputs();
    try {
      const slash: ContentPart[] = [
        {
          type: "mention",
          entryId: "entry",
          kind: "command",
          name: "Review",
          arguments: "now",
          invocation: { type: "slash", name: "review" },
        },
        { type: "text", text: "look" },
      ];
      // The seed signed `input:slash` in TypeScript; the Rust `sending` signs the same parts.
      seam.probe.inputFacts("inputs.sending", {
        thread: id,
        key: "input:rust-slash",
        parts: slash,
        provider: "claude",
        generation: 7,
      });
      const first = claudeAdmissions(slash)[0];
      if (typeof first !== "string") throw new Error("the slash command is not one text admission");
      const ts = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo(first, "native-ts"),
        generation: 7,
      });
      expect(ts).toMatchObject({ item: "input:slash" });
      // The next echo of the same text can only match the Rust-signed row.
      const rust = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo(first, "native-rust"),
        generation: 7,
      });
      expect(rust).toMatchObject({
        item: "input:rust-slash",
        draft: { origin: { kind: "person", commandId: "slash" }, synthetic: false },
      });
    } finally {
      await seam.close();
    }
  });

  test("a started run takes the inputs its generation was sent, and no others", async () => {
    const { seam, thread: id } = await seededInputs();
    try {
      const seventh = seam.probe.inputFacts("bindStartedRun", {
        thread: id,
        run: "run-later",
        generation: 7,
      }) as { item: { runId?: string; parts: { text: string }[] } }[];
      expect(seventh).toHaveLength(1);
      expect(seventh[0]!.item.runId).toBe("run-later");
      expect(seventh[0]!.item.parts.map((part) => part.text)).toEqual(["one"]);

      const eighth = seam.probe.inputFacts("bindStartedRun", {
        thread: id,
        run: "run-later",
        generation: 8,
      }) as { item: { runId?: string; parts: { text: string }[] } }[];
      expect(eighth).toHaveLength(1);
      expect(eighth[0]!.item.runId).toBe("run-later");
      expect(eighth[0]!.item.parts.map((part) => part.text)).toEqual(["two"]);
    } finally {
      await seam.close();
    }
  });
});
