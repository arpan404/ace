import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { backup } from "node:sqlite";
import { Engine, Store } from "@ace/daemon";
import { harness, scriptFrames, start } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function savedShell() {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "item.delta",
            agent: "root",
            item: "shell",
            field: "output",
            append: "base output",
          }),
        ],
      },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  const path = join(h.home, "saved.sqlite");
  await backup(
    h.store.atomic((db) => db),
    path,
  );
  const store = new Store(path);
  cleanups.push(async () => store.close());
  const construct = () => {
    const engine = new Engine(store, { registry: h.registry, clock: h.clock });
    cleanups.push(() => engine.close());
  };
  const state = () =>
    store.atomic((db) => {
      const row = db.prepare("SELECT state FROM thread_state WHERE thread_id=?").get(id);
      if (!row) throw new Error("Missing saved shell");
      return String(row.state);
    });
  const legacyOutput = () =>
    store.atomic((db) => {
      db.prepare(`UPDATE engine_state_records SET value=json_set(value,'$.call.detail.output',?)
      WHERE thread_id=? AND section='items' AND key='shell'`).run("legacy base", id);
      db.prepare(
        `INSERT INTO engine_state_appends(thread_id,section,key,patch) VALUES (?, 'items', 'shell', ?)`,
      ).run(id, JSON.stringify({ path: ["call", "detail", "output"], text: " legacy append" }));
    });
  const output = () =>
    store.atomic((db) => ({
      base: db
        .prepare(
          "SELECT value FROM engine_state_records WHERE thread_id=? AND section='items' AND key='shell'",
        )
        .get(id)?.value,
      chunks: db
        .prepare(
          "SELECT patch FROM engine_state_appends WHERE thread_id=? AND section='items' AND key='shell' ORDER BY id",
        )
        .all(id)
        .map((row) => row.patch),
    }));
  return { id, store, construct, state, legacyOutput, output };
}

test.each([1, 6, 7, 8, 999, 0, "invalid"])(
  "development engine schema %s is rejected before recovering or rewriting shell output",
  async (version) => {
    const saved = await savedShell();
    saved.legacyOutput();
    saved.store.atomic((db) => {
      db.prepare("UPDATE engine_schema_version SET version=?").run(version);
      db.prepare("UPDATE thread_state SET state=json_set(state,'$.engineSnapshot',2)").run();
    });
    const before = saved.state();
    const output = saved.output();
    const seq = saved.store.headSeq();
    expect(saved.construct).toThrow(
      /Unsupported engine schema version.*fresh development database/,
    );
    expect(saved.state()).toBe(before);
    expect(saved.output()).toEqual(output);
    expect(saved.store.headSeq()).toBe(seq);
    expect(
      saved.store.atomic(
        (db) => db.prepare("SELECT version FROM engine_schema_version").get()?.version,
      ),
    ).toBe(version);
  },
);

test("unversioned development engine data is rejected without trying to initialize over it", async () => {
  const saved = await savedShell();
  saved.legacyOutput();
  saved.store.atomic((db) => db.exec("DELETE FROM engine_schema_version"));
  const before = saved.state();
  const output = saved.output();
  expect(saved.construct).toThrow(/Unsupported engine schema version.*fresh development database/);
  expect(saved.state()).toBe(before);
  expect(saved.output()).toEqual(output);
});

test.each([undefined, 1, 2, 8, 999, "invalid"])(
  "snapshot format %s is rejected clearly even when the database declares the current schema",
  async (format) => {
    const saved = await savedShell();
    saved.legacyOutput();
    saved.store.atomic((db) => {
      if (format === undefined) {
        // Old inline snapshots lacked a format marker and kept entities in the header.
        db.prepare(`UPDATE thread_state SET state=json_remove(json_set(state,'$.items',json(
        (SELECT json_group_object(key,json(value)) FROM engine_state_records WHERE thread_id=? AND section='items')
      )),'$.engineSnapshot') WHERE thread_id=?`).run(saved.id, saved.id);
      } else
        db.prepare(
          "UPDATE thread_state SET state=json_set(state,'$.engineSnapshot',?) WHERE thread_id=?",
        ).run(format, saved.id);
    });
    const before = saved.state();
    const output = saved.output();
    const seq = saved.store.headSeq();
    expect(saved.construct).toThrow(
      /Unsupported engine snapshot format.*fresh development database/,
    );
    expect(saved.state()).toBe(before);
    expect(saved.output()).toEqual(output);
    expect(saved.store.headSeq()).toBe(seq);
  },
);
