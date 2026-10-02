import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { UsageStore } from "./index.ts";
import { query } from "./test-support.ts";

it("upgrading a legacy projection clears unrebuildable observations and resumes retained history from zero", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-usage-upgrade-"));
  const path = join(home, "usage.sqlite");
  let store: UsageStore | undefined;
  try {
    const legacy = new DatabaseSync(path);
    try {
      // On-disk v1 fixture: its quota ledger did not retain the originating thread.
      legacy.exec(`
        CREATE TABLE usage_meta(id INTEGER PRIMARY KEY, version INTEGER, cursor INTEGER, timezone TEXT);
        INSERT INTO usage_meta VALUES(1,1,55,'UTC');
        CREATE TABLE usage_threads(thread TEXT PRIMARY KEY, workspace TEXT, provider TEXT);
        INSERT INTO usage_threads VALUES('deleted','w','codex');
        CREATE TABLE usage_agents(agent TEXT PRIMARY KEY, thread TEXT, parent TEXT, model TEXT, provider TEXT, run TEXT);
        INSERT INTO usage_agents VALUES('a','deleted',NULL,NULL,'codex','legacy');
        CREATE TABLE usage_counters(agent TEXT, scope TEXT, input INTEGER, output INTEGER, cached INTEGER, reasoning INTEGER, write INTEGER, write1h INTEGER, cost REAL, PRIMARY KEY(agent,scope));
        INSERT INTO usage_counters VALUES('a','legacy',99,0,0,0,0,0,2);
        CREATE TABLE usage_daily(day TEXT, thread TEXT, agent TEXT, provider TEXT, account TEXT, model TEXT, workspace TEXT, billing TEXT, input INTEGER, output INTEGER, cached INTEGER, reasoning INTEGER, write INTEGER, write1h INTEGER, cost REAL, PRIMARY KEY(day,thread,agent,provider,account,model,workspace,billing));
        INSERT INTO usage_daily VALUES('2026-10-02','deleted','a','codex','account','','w','unknown',99,0,0,0,0,0,2);
        CREATE TABLE usage_increments(seq INTEGER PRIMARY KEY, at INTEGER, account TEXT, input INTEGER, output INTEGER, cost REAL);
        INSERT INTO usage_increments VALUES(55,1790942400000,'account',99,0,2);
      `);
    } finally {
      legacy.close();
    }
    store = new UsageStore(path);
    expect(store.cursor()).toBe(0);
    expect(store.summary(query).rows[0]?.totals.inputTokens).toBe(0);
    const at = Date.parse("2026-10-02T12:00Z");
    expect(
      store.burn(
        "account",
        { id: "quota", unit: "tokens", start: at - 1, end: at + 1000, remaining: 100 },
        at + 1,
      ).observed,
    ).toBe(0);
    store.ingest({
      afterSeq: 0,
      throughSeq: 3,
      events: [
        {
          seq: 1,
          at,
          threadId: "retained",
          payload: { type: "thread.created", workspace: "w", provider: "codex" },
        },
        {
          seq: 2,
          at,
          threadId: "retained",
          payload: { type: "agent.created", id: "a", parent: null, model: null, provider: "codex" },
        },
        {
          seq: 3,
          at,
          threadId: "retained",
          payload: {
            type: "usage.updated",
            agentId: "a",
            inputTokens: 10,
            outputTokens: 2,
            accountId: "account",
          },
        },
      ],
    });
    store.close();
    store = new UsageStore(path);
    expect(store.cursor()).toBe(3);
    expect(store.summary({ ...query, groupBy: ["thread"] }).rows).toMatchObject([
      { dimensions: { thread: "retained" }, totals: { inputTokens: 10 } },
    ]);
    expect(
      store.burn(
        "account",
        { id: "quota", unit: "tokens", start: at - 1, end: at + 1000, remaining: 100 },
        at + 1,
      ).observed,
    ).toBe(12);
  } finally {
    store?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
