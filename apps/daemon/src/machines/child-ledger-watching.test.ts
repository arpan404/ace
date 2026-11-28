import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "../store.ts";
import { ChildLedger } from "./child-ledger.ts";
import { RECHECK_WINDOW_MS } from "./child-recheck.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const now = 10 * RECHECK_WINDOW_MS;

/** A store whose `machine_children` holds 50,000 children that left the re-check long ago. */
function history() {
  const home = mkdtempSync(join(tmpdir(), "ace-ledger-watching-"));
  const store = new Store(join(home, "events.sqlite"));
  cleanups.push(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const put = (id: string, settled: 0 | 1, settledAt: number | null) =>
    store.atomic((db) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO machine_children (id, request_key, parent_thread, parent_agent,
            machine, role, provider, created_at, view, settled, delivered, settled_at)
          VALUES (?, ?, 'parent', 'agent', 'studio', 'Task', 'claude', 0, NULL, ?, 1, ?)`,
        )
        .run(id, `parent:${id}`, settled, settledAt),
    );
  store.atomic((db) => {
    const insert = db.prepare(
      `INSERT INTO machine_children (id, request_key, parent_thread, parent_agent, machine, role,
        provider, created_at, view, settled, delivered, settled_at)
      VALUES (?, ?, 'parent', 'agent', 'studio', 'Task', 'claude', 0, NULL, 1, 1, ?)`,
    );
    for (let index = 0; index < 50_000; index++)
      insert.run(`retired-${index}`, `parent:retired-${index}`, null);
  });
  return { store, put, ledger: new ChildLedger(store) };
}

it("a remote child is watched while it works or while its settled window is open", () => {
  const { put, ledger } = history();
  expect(ledger.watchingRemote()).toBe(false);
  put("child", 0, null);
  expect(ledger.watchingRemote()).toBe(true);
  put("child", 1, now - 1000);
  expect(ledger.watchingRemote()).toBe(true);
  // A day on, its final check not yet answered: still watched, whatever the clock says.
  put("child", 1, now - 2 * RECHECK_WINDOW_MS);
  expect(ledger.watchingRemote()).toBe(true);
  // The re-check let it go: its window is closed.
  put("child", 1, null);
  expect(ledger.watchingRemote()).toBe(false);
});

it("checking for a watched remote child reads only bounded indexes (ADR 0170)", () => {
  const { store } = history();
  const plans: string[] = [];
  const atomic = store.atomic.bind(store);
  const traced = new Proxy(store, {
    get(target, prop) {
      if (prop === "atomic")
        return <T>(run: (db: import("node:sqlite").DatabaseSync) => T) =>
          atomic((db) =>
            run(
              new Proxy(db, {
                get(inner, key) {
                  if (key === "prepare")
                    return (sql: string) => {
                      const params = Array.from({ length: sql.split("?").length - 1 }, () => 0);
                      const plan = inner.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
                      plans.push(plan.map((row) => String(row["detail"])).join("; "));
                      return inner.prepare(sql);
                    };
                  const value: unknown = Reflect.get(inner, key, inner);
                  return typeof value === "function" ? value.bind(inner) : value;
                },
              }),
            ),
          );
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(new ChildLedger(traced).watchingRemote()).toBe(false);
  expect(plans).toEqual([
    // A partial index holding only rows with settled=0: scanning it reads only working children.
    "SCAN machine_children USING COVERING INDEX machine_children_unsettled",
    "SEARCH machine_children USING COVERING INDEX machine_children_settled (settled=? AND settled_at>?)",
  ]);
});
