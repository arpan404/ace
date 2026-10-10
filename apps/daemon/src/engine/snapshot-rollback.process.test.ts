import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@ace/protocol";
import type { ThreadState } from "@ace/core";
import { Store } from "../store.ts";
import { EngineRepository } from "./repository.ts";
import { createEngineThread } from "./create-thread.ts";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "snapshot-rollback-"));
  const store = new Store(join(home, "state.sqlite"));
  try {
    const repo = new EngineRepository(store);
    const id = ThreadId.parse("rollback-thread");
    createEngineThread(repo, {
      id,
      workspaceId: store.createWorkspace(home, "Fixture"),
      title: "Rollback",
      selection: { provider: "codex", options: {} },
      cwd: home,
      at: 1,
      silenceMs: 100,
    });
    repo.apply(
      id,
      [
        { type: "turn.started", agent: "root", trigger: "user" },
        {
          type: "item.upsert",
          agent: "root",
          item: "message",
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: "committed" }],
            complete: true,
          },
        },
      ],
      2,
    );
    return {
      store,
      repo,
      id,
      async close() {
        await store.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await store.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

function change(state: ThreadState, text: string, silenceMs: number) {
  state.config.silenceMs = silenceMs;
  const item = state.items.message;
  if (item?.type !== "message") throw new Error("Missing fixture message");
  state.items.message = { ...item, parts: [{ type: "text", text }] };
}

function expectState(state: ThreadState, text: string, silenceMs: number) {
  expect(state.config.silenceMs).toBe(silenceMs);
  expect(state.items.message).toMatchObject({ parts: [{ type: "text", text }] });
}

test("a direct rejected save restores the committed header and message without advancing events", async () => {
  const h = await fixture();
  try {
    const before = h.store.headSeq();
    h.store.atomic((db) =>
      db.exec(`
      CREATE TRIGGER reject_message BEFORE INSERT ON engine_state_records
      WHEN NEW.section='items' BEGIN SELECT RAISE(ABORT,'reject message'); END
    `),
    );
    change(h.repo.requireState(h.id), "rejected", 200);
    expect(() => h.repo.save(h.repo.requireState(h.id), [], 3)).toThrow("reject message");
    expect(h.store.headSeq()).toBe(before);
    expectState(h.repo.requireState(h.id), "committed", 100);
    h.store.atomic((db) => db.exec("DROP TRIGGER reject_message"));
    const recovered = h.repo.requireState(h.id);
    change(recovered, "next commit", 300);
    h.repo.save(recovered, [], 4);
    h.repo.evict(h.id);
    expectState(h.repo.requireState(h.id), "next commit", 300);
    expect(h.store.headSeq()).toBe(before);
  } finally {
    await h.close();
  }
});

test("a later outer rollback discards a successful nested save whose event sequence did not change", async () => {
  const h = await fixture();
  try {
    const before = h.store.headSeq();
    expect(() =>
      h.store.atomic(() => {
        const state = h.repo.requireState(h.id);
        change(state, "rolled back", 200);
        h.repo.save(state, [], 3);
        throw new Error("outer rollback");
      }),
    ).toThrow("outer rollback");
    expect(h.store.headSeq()).toBe(before);
    expectState(h.repo.requireState(h.id), "committed", 100);
    const recovered = h.repo.requireState(h.id);
    change(recovered, "next commit", 300);
    h.repo.save(recovered, [], 4);
    h.repo.evict(h.id);
    expectState(h.repo.requireState(h.id), "next commit", 300);
    expect(h.store.headSeq()).toBe(before);
  } finally {
    await h.close();
  }
});

test("a caught savepoint rollback reloads state before a subsequent save in the same outer transaction", async () => {
  const h = await fixture();
  try {
    const before = h.store.headSeq();
    h.store.atomic(() => {
      expect(() =>
        h.store.atomic(() => {
          const state = h.repo.requireState(h.id);
          change(state, "rolled back", 200);
          h.repo.save(state, [], 3);
          throw new Error("nested rollback");
        }),
      ).toThrow("nested rollback");
      expect(h.store.headSeq()).toBe(before);
      const recovered = h.repo.requireState(h.id);
      expectState(recovered, "committed", 100);
      recovered.config.silenceMs = 300;
      h.repo.save(recovered, [], 4);
    });
    h.repo.evict(h.id);
    expectState(h.repo.requireState(h.id), "committed", 300);
    expect(h.store.headSeq()).toBe(before);
  } finally {
    await h.close();
  }
});
