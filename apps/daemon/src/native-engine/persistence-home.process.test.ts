// SPDX-License-Identifier: Apache-2.0
/**
 * E5.3's cross-mode proof (brief constraint 2): a home written with the engine switch on opens
 * with it off, and the reverse. The real edge is a second process, so each direction ends in a
 * child that builds the other engine on the same home.
 *
 * The TypeScript child (`persistence-home.child.ts`) builds the TypeScript `Engine` in-process
 * with a scripted adapter: no provider CLI and no daemon. Rows are asserted with plain SQL, the
 * engine's own tables, never through `store.snapshotThread`.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { Store } from "../store.ts";
import { createDevThread } from "../commands.ts";
import { engineSeam } from "./testing.ts";

const native = engineBackend() === "native";
const child = join(fileURLToPath(new URL(".", import.meta.url)), "persistence-home.child.ts");

type Row = Record<string, unknown>;

/** The engine's own rows of one thread, by plain SQL. */
function engineRows(store: Store, threadId: string) {
  return store.atomic((db) => ({
    header: db.prepare("SELECT state,seq FROM thread_state WHERE thread_id=?").get(threadId) as
      | Row
      | undefined,
    records: db
      .prepare(
        "SELECT section,key,value FROM engine_state_records WHERE thread_id=? ORDER BY rowid",
      )
      .all(threadId) as Row[],
    appends: db
      .prepare("SELECT section,key,patch FROM engine_state_appends WHERE thread_id=? ORDER BY id")
      .all(threadId) as Row[],
  }));
}

/** Every thread the home holds, oldest first. */
function threadIds(store: Store): string[] {
  return (
    store.atomic((db) => db.prepare("SELECT id FROM threads ORDER BY rowid").all()) as Row[]
  ).map((row) => String(row["id"]));
}

/** Runs the TypeScript child on `home`; its stdio fails the test, never the other engine. */
function runChild(home: string, mode: string, thread?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ACE_HOME: home };
  delete env.ACE_ENGINE;
  delete env.ACE_NATIVE_CROSS;
  if (thread !== undefined) env.ACE_THREAD = thread;
  const result = spawnSync(process.execPath, [child, mode], { env, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`the TypeScript child exited ${String(result.status)}: ${result.stderr}`);
  return result.stdout;
}

/** Copies a home's SQLite files to a second directory, so the child can open it alone. */
function copyHome(from: string, to: string): void {
  for (const name of readdirSync(from))
    if (name.startsWith("events.sqlite")) copyFileSync(join(from, name), join(to, name));
}

describe.runIf(native)("engine persistence across modes", () => {
  test("a home the TypeScript engine wrote opens natively: its candidates recover, one thread is skipped, and one more fold per thread stores its rows", async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-engine-home-ts-"));
    const reports: string[] = [];
    const seam = await engineSeam({
      options: { home, onError: (error) => reports.push(String(error)) },
      seedWithTypeScript: { script: child, args: ["seed"] },
    });
    try {
      const ids = threadIds(seam.store);
      expect(ids).toHaveLength(4);
      const [working, done, long, refused] = ids as [string, string, string, string];
      // The rows the TypeScript engine wrote are the rows this build reads.
      for (const id of [working, done, long]) {
        const rows = engineRows(seam.store, id);
        expect(rows.header).toBeDefined();
        const header = JSON.parse(String(rows.header?.state)) as Row;
        expect(header["engineSnapshot"]).toBe(9);
        expect(rows.records.map((row) => row["section"])).toContain("items");
      }
      const longRows = engineRows(seam.store, long);
      // The scripted frames fold as one upsert batch, so the long text is the record's own:
      // the patch form needs the live path (the seam's live-delta test covers it).
      // The long thread's text is readable through the native engine below; its patch form
      // needs the live path, which the seam's live-delta test covers.
      const longRecord = longRows.records.find((row) => row["key"] === "long");
      const longParts = (JSON.parse(String(longRecord?.value)) as Row)["parts"];
      const recordText = (longParts as { type: string; text: string }[])
        .map((part) => part.text)
        .join("");
      // The text is either in the record or in its patches (a live append batch).
      const patchText = longRows.appends
        .filter((row) => row["key"] === "long")
        .map((row) => (JSON.parse(String(row["patch"])) as { text: string }).text)
        .join("");
      expect(recordText.length + patchText.length).toBeGreaterThan(32_768);
      expect(JSON.parse(String(engineRows(seam.store, refused).header?.state))["items"]).toBe(
        undefined,
      );
      // The native engine opens the same home.
      await seam.engine.ready();
      expect(reports.filter((report) => report.includes("Invalid saved core state"))).toHaveLength(
        1,
      );
      for (const id of [working, done, long]) expect(seam.engine.hasState(id as never)).toBe(true);
      // Reading the skipped thread's state surfaces what it cannot read.
      expect(() =>
        seam.probe.apply(refused, [{ type: "turn.ended", agent: "root" }], 4_000),
      ).toThrow(/Invalid saved core state/);
      // One more fold per readable thread, stored beside the rows the child wrote.
      seam.probe.passThroughCollaborators();
      for (const [id, extra] of [
        [working, "native after"],
        [done, "native after"],
      ] as const) {
        const before = engineRows(seam.store, id);
        seam.probe.apply(
          id,
          [
            {
              type: "item.upsert",
              agent: "root",
              item: `native-${id}`,
              draft: {
                type: "message",
                role: "assistant",
                parts: [{ type: "text", text: extra }],
                complete: true,
              },
            },
            { type: "turn.ended", agent: "root", outcome: "completed" },
          ],
          9_000,
        );
        const after = engineRows(seam.store, id);
        expect(after.records.length).toBeGreaterThan(before.records.length);
        expect(after.records.map((row) => row["key"])).toContain(`native-${id}`);
        expect(Number(after.header?.seq)).toBe(seam.store.headSeq());
      }
      // The long thread's text reads back through the native engine: one more append continues
      // the stored patches.
      seam.probe.apply(
        long,
        [
          { type: "item.delta", agent: "root", item: "long", field: "text", append: "!" },
          { type: "turn.ended", agent: "root", outcome: "completed" },
        ],
        10_000,
      );
      const longAfter = engineRows(seam.store, long);
      const afterText =
        (
          (
            JSON.parse(String(longAfter.records.find((row) => row["key"] === "long")?.value)) as Row
          )["parts"] as { type: string; text: string }[] | undefined
        )
          ?.map((part) => part.text)
          .join("") ?? "";
      const afterPatches = longAfter.appends
        .filter((row) => row["key"] === "long")
        .map((row) => (JSON.parse(String(row["patch"])) as { text: string }).text)
        .join("");
      // The full rebuilt text: 40,000 appended characters and the native engine's one more.
      expect(afterText + afterPatches).toBe(`${"x".repeat(40_000)}!`);
    } finally {
      await seam.close();
    }
  });

  test("a home the native engine wrote opens with the TypeScript engine, which writes the next rows", async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-engine-home-native-"));
    const other = mkdtempSync(join(tmpdir(), "ace-engine-home-native-copy-"));
    const seam = await engineSeam({ options: { home } });
    let working = "";
    try {
      await seam.engine.ready();
      seam.probe.passThroughCollaborators();
      const workspace = seam.store.createWorkspace(seam.home, "E5.3");
      const thread = createDevThread(seam.store, workspace);
      working = thread.id;
      const state = seam.store.atomic((db) =>
        db.prepare("SELECT state FROM thread_state WHERE thread_id=?").get(working),
      ) as Row | undefined;
      if (state) throw new Error("the dev thread already has engine state");
      // The native engine writes the header and a working turn, as its own fold does.
      seam.store.atomic((db) => {
        db.prepare("INSERT INTO thread_state VALUES (?, ?, 0)").run(working, freshHeader(working));
        // A session binding the TypeScript engine's save reads its execution source from.
        db.prepare(
          "INSERT INTO engine_sessions (thread_id, cwd, model, native_session_id, backend) VALUES (?, '/tmp', 'model', 'native-1', NULL)",
        ).run(working);
      });
      seam.probe.apply(
        working,
        [
          { type: "turn.started", agent: "root", trigger: "user", nativeTurnId: "turn-1" },
          {
            type: "item.upsert",
            agent: "root",
            item: "before",
            draft: {
              type: "message",
              role: "assistant",
              parts: [{ type: "text", text: "before" }],
              complete: true,
            },
          },
        ],
        1_000,
      );
      await seam.engine.flush();
      const written = engineRows(seam.store, working);
      expect(written.records.map((row) => row["key"])).toContain("before");
      expect(JSON.parse(String(written.header?.state))["engineSnapshot"]).toBe(9);
      copyHome(home, other);
    } finally {
      await seam.close();
    }
    runChild(other, "continue", working);
    // Read what the TypeScript engine wrote on top, with plain SQL.
    const store = new Store(join(other, "events.sqlite"));
    try {
      const rows = engineRows(store, working);
      expect(rows.records.map((row) => row["key"])).toContain("ts-after");
      const item = rows.records.find((row) => row["key"] === "ts-after");
      const stored = JSON.parse(String(item?.value)) as Row;
      expect(JSON.stringify(stored["parts"])).toBe('[{"type":"text","text":"after"}]');
      // The TypeScript engine read the header this build wrote and kept its version.
      expect(JSON.parse(String(rows.header?.state))["engineSnapshot"]).toBe(9);
      expect(rows.records.map((row) => row["key"])).toContain("before");
      // The reopened transcript holds both sides' messages.
      const transcript = store.snapshotThread(working as never);
      const texts = Object.values(transcript.items)
        .flatMap((entry) => ("parts" in entry ? entry.parts : []))
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(" ");
      expect(texts).toContain("before");
      expect(texts).toContain("after");
    } finally {
      await store.close();
      rmSync(other, { recursive: true, force: true });
    }
  });
});

/** A header a fresh thread would have: the core's own state, version 9. */
function freshHeader(threadId: string): string {
  return JSON.stringify({
    engineSnapshot: 9,
    threadId,
    config: { provider: "codex", silenceMs: 30_000 },
    rootKey: "root",
    agents: {},
    runs: {},
    items: {},
    interactions: {},
    tasks: {},
    interactionHistory: {},
    taskHistory: {},
    indexes: {
      liveTools: {},
      openText: {},
      pendingInteractions: {},
      runningTasks: {},
      agentKeysById: {},
      childrenByParent: {},
      pendingSpawnLinks: {},
      pendingItemLinks: {},
    },
    outcomeOrder: 0,
    pendingNotices: [],
    itemLinks: {},
    queueCount: 0,
    queueSources: { engine: 0, provider: 0 },
    hasRun: false,
    status: { state: "new" },
  });
}
