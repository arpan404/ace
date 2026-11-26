// SPDX-License-Identifier: Apache-2.0
/**
 * E5.4d's queue commands on a home the TypeScript engine wrote: the real edge is a TypeScript
 * writer and a native reader over one SQLite file. Each runs only with the switch on and names
 * the (a) test that replaces it.
 *
 * - edits, moves, removals and pause: `queue-recovery.process` `:17`.
 * - a stale revision: `queue-recovery.process` `:73`.
 * - a failed head's hold: `held-send-release.process` `:62`, `:93`.
 * - a selecting steer kept queued: `queue-selection.process` `:84`, `:219`.
 * - guest and host refusals: `guest-admission.process` `:5`.
 */
import { describe, expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { native, queueUpdated, receipt, seeded } from "./testing/commands-home-support.ts";

describe.runIf(native)("E5.4d queue commands on a TypeScript-written home", () => {
  test("queue edits commit natively: edit, move, remove and pause, each a single revision bump with one queue.updated", async () => {
    const { seam, edits } = await seeded();
    try {
      const send = (id: string, payload: Record<string, unknown>) =>
        seam.engine.handler.handle(receipt(payload, id), undefined as never);
      let revision = seam.engine.queue(edits as never).revision;
      let updated = queueUpdated(seam.store, edits);
      const expectBump = (before: number) => {
        revision += 1;
        updated += 1;
        expect(seam.engine.queue(edits as never).revision).toBe(revision);
        expect(queueUpdated(seam.store, edits)).toBe(before + 1);
      };

      let before = updated;
      expect(
        send("edit", {
          type: "queue.edit",
          threadId: edits,
          expectedRevision: revision,
          messageId: "edit-b",
          input: [{ type: "text", text: "new words" }],
        }),
      ).toEqual({ commandId: "edit", ok: true });
      expectBump(before);

      before = updated;
      expect(
        send("move", {
          type: "queue.move",
          threadId: edits,
          expectedRevision: revision,
          messageId: "edit-c",
          after: "edit-a",
        }),
      ).toEqual({ commandId: "move", ok: true });
      expectBump(before);
      expect(seam.engine.queue(edits as never).messages.map((message) => message.id)).toEqual([
        "edit-a",
        "edit-c",
        "edit-b",
      ]);

      before = updated;
      expect(
        send("remove", {
          type: "queue.remove",
          threadId: edits,
          expectedRevision: revision,
          messageId: "edit-c",
        }),
      ).toEqual({ commandId: "remove", ok: true });
      expectBump(before);
      expect(seam.engine.queue(edits as never).messages.map((message) => message.id)).toEqual([
        "edit-a",
        "edit-b",
      ]);

      before = updated;
      expect(
        send("pause", { type: "queue.pause", threadId: edits, expectedRevision: revision }),
      ).toEqual({ commandId: "pause", ok: true });
      expectBump(before);
      expect(seam.engine.queue(edits as never)).toMatchObject({ paused: true, reason: "manual" });
    } finally {
      await seam.close();
    }
  });

  test("an edited command is stored in the TypeScript's byte-exact form", async () => {
    const { seam, edits } = await seeded();
    try {
      const storedPayload = (): string =>
        (
          seam.store.atomic((db) =>
            db.prepare("SELECT payload FROM intents WHERE command_id='edit-b'").get(),
          ) as { payload: string }
        ).payload;
      const before = JSON.parse(storedPayload()) as {
        id: string;
        deviceId: string;
        payload: Record<string, unknown>;
      };
      const input = [{ type: "text", text: "new words" }];
      expect(
        seam.engine.handler.handle(
          receipt(
            {
              type: "queue.edit",
              threadId: edits,
              expectedRevision: seam.engine.queue(edits as never).revision,
              messageId: "edit-b",
              input,
            },
            "edit-bytes",
          ),
          undefined as never,
        ),
      ).toEqual({ commandId: "edit-bytes", ok: true });
      // The TypeScript ran `Command.parse` first (`queue-commands.ts:62`), so its stored text is
      // the schema's: defaults filled, unknown keys dropped, keys in schema order.
      expect(storedPayload()).toBe(
        JSON.stringify(Command.parse({ ...before, payload: { ...before.payload, input } })),
      );
    } finally {
      await seam.close();
    }
  });

  test("two receipts on one revision: the first wins, the second gets queue_conflict and commits nothing", async () => {
    const { seam, edits } = await seeded();
    try {
      const revision = seam.engine.queue(edits as never).revision;
      const updated = queueUpdated(seam.store, edits);
      expect(
        seam.engine.handler.handle(
          receipt({ type: "queue.pause", threadId: edits, expectedRevision: revision }, "first"),
          undefined as never,
        ),
      ).toEqual({ commandId: "first", ok: true });
      expect(
        seam.engine.handler.handle(
          receipt(
            {
              type: "queue.edit",
              threadId: edits,
              expectedRevision: revision,
              messageId: "edit-a",
              input: [{ type: "text", text: "lost" }],
            },
            "second",
          ),
          undefined as never,
        ),
      ).toEqual({ commandId: "second", ok: false, error: "queue_conflict" });
      expect(seam.engine.queue(edits as never).revision).toBe(revision + 1);
      expect(queueUpdated(seam.store, edits)).toBe(updated + 1);
      expect(seam.engine.queue(edits as never).messages[0]?.input).toEqual([
        { type: "text", text: "first word" },
      ]);
    } finally {
      await seam.close();
    }
  });

  test("removing the failed head releases a not_sent hold; removing one behind it keeps the hold", async () => {
    const { seam, held, heldBehind } = await seeded();
    try {
      const remove = (thread: string, id: string, messageId: string) =>
        seam.engine.handler.handle(
          receipt(
            {
              type: "queue.remove",
              threadId: thread,
              expectedRevision: seam.engine.queue(thread as never).revision,
              messageId,
            },
            id,
          ),
          undefined as never,
        );
      expect(remove(held, "head", "held-head")).toMatchObject({ ok: true });
      expect(seam.engine.queue(held as never)).toMatchObject({ paused: false, reason: null });

      expect(remove(heldBehind, "behind", "held2-behind")).toMatchObject({ ok: true });
      expect(seam.engine.queue(heldBehind as never)).toMatchObject({
        paused: true,
        reason: "not_sent",
      });
    } finally {
      await seam.close();
    }
  });

  test("a guest thread and Spade's own threads refuse with their titles and details", async () => {
    const { seam, guest, bot, host } = await seeded();
    try {
      expect(
        seam.engine.handler.handle(
          receipt(
            {
              type: "thread.send",
              threadId: guest,
              input: [{ type: "text", text: "hello" }],
            },
            "guest-send",
          ),
          undefined as never,
        ),
      ).toEqual({
        commandId: "guest-send",
        ok: false,
        error: "guest_thread",
        title: "No agent here",
        detail: "This thread holds work from Rijan's MacBook; it has no agent here.",
      });
      expect(
        seam.engine.handler.handle(
          receipt({ type: "thread.rename", threadId: bot, title: "Mine" }, "bot-rename"),
          undefined as never,
        ),
      ).toEqual({
        commandId: "bot-rename",
        ok: false,
        error: "host_thread",
        title: "A Spade bot's old thread",
        detail: "Spade bots no longer run here; talk to the bot in Spade.",
      });
      expect(
        seam.engine.handler.handle(
          receipt(
            {
              type: "thread.send",
              threadId: host,
              input: [{ type: "text", text: "hello" }],
            },
            "host-send",
          ),
          undefined as never,
        ),
      ).toEqual({
        commandId: "host-send",
        ok: false,
        error: "host_thread",
        title: "Spade's own thread",
        detail: "Spade works through this thread; nothing runs in it.",
      });
    } finally {
      await seam.close();
    }
  });

  test("editing a selecting message to steer on a provider that can't steer keeps it queued with its selection", async () => {
    // The split half needs an active root run and a reserved slot (E5.5's live actor), which
    // this seam cannot seed until E5.5 lands; `admitSteer`'s selection branch is its own test.
    const { seam, selecting } = await seeded();
    try {
      expect(
        seam.engine.handler.handle(
          receipt(
            {
              type: "queue.edit",
              threadId: selecting,
              expectedRevision: seam.engine.queue(selecting as never).revision,
              messageId: "select-a",
              input: [{ type: "text", text: "edited steer" }],
              delivery: "steer",
            },
            "steer-edit",
          ),
          undefined as never,
        ),
      ).toEqual({ commandId: "steer-edit", ok: true });
      const stored = seam.store.atomic((db) =>
        db.prepare("SELECT payload FROM intents WHERE command_id='select-a'").get(),
      ) as { payload: string };
      const payload = (JSON.parse(stored.payload) as { payload: Record<string, unknown> }).payload;
      expect(payload).toEqual({
        type: "thread.send",
        model: "gpt-5.5",
        threadId: selecting,
        input: [{ type: "text", text: "edited steer" }],
        delivery: "queue",
      });
    } finally {
      await seam.close();
    }
  });
});
