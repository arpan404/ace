import { performance } from "node:perf_hooks";
import type { StatementSync } from "node:sqlite";
import { storageFixture } from "../src/storage/test-support.ts";

// Plans and applies thread cleanup for one archived delegation tree of N threads, in a temp
// SQLite database. Sends no model requests. Run: node apps/daemon/bench/storage-protections.ts
// Set STORAGE_BENCH_SIZES=100,300,1000 to choose tree sizes, and STORAGE_BENCH_ROUNDS to stop
// after that many plan/apply rounds (a plan reviews a bounded page of items).
const maxRounds = Number.parseInt(process.env.STORAGE_BENCH_ROUNDS ?? "1000", 10);
const sizes = (process.env.STORAGE_BENCH_SIZES ?? "100,300,1000")
  .split(",")
  .map((size) => Number.parseInt(size, 10));

async function measure(size: number) {
  const f = await storageFixture();
  try {
    const root = f.thread("root");
    const children = Array.from({ length: size - 1 }, (_, index) => f.thread(`child-${index}`));
    f.store.atomic((db) => {
      db.exec(
        "CREATE TABLE delegation_participants(thread_id TEXT PRIMARY KEY,root_id TEXT); CREATE TABLE delegation_trees(root_id TEXT PRIMARY KEY,active INTEGER)",
      );
      const insert = db.prepare("INSERT INTO delegation_participants VALUES (?,?)");
      for (const thread of [root, ...children]) insert.run(thread.id, root.id);
    });
    // Count every statement execution that goes through the Store.
    let queries = 0;
    const statement = f.store.statement.bind(f.store);
    f.store.statement = (sql: string): StatementSync => {
      const prepared = statement(sql);
      return new Proxy(prepared, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (key === "get" || key === "all" || key === "run" || key === "iterate") queries++;
            return Reflect.apply(value, target, args);
          };
        },
      });
    };
    const rounds: {
      items: number;
      planMs: number;
      planQueries: number;
      applyMs: number;
      applyQueries: number;
    }[] = [];
    for (let round = 0; round < maxRounds; round++) {
      queries = 0;
      let started = performance.now();
      const plan = await f.storage.plan("owner", {
        op: "cleanup.plan",
        kinds: ["threads"],
        forceItems: [],
      });
      const planMs = performance.now() - started;
      const planQueries = queries;
      const items = plan.items.filter((item) => item.kind === "threads");
      if (!items.length) break;
      if (!items.every((item) => item.disposition === "remove"))
        throw new Error("bench tree should be removable");
      queries = 0;
      started = performance.now();
      const result = await f.storage.apply("owner", plan.id, plan.revision);
      if (result.state !== "complete") throw new Error(`apply ended ${result.state}`);
      rounds.push({
        items: items.length,
        planMs: Math.round(planMs),
        planQueries,
        applyMs: Math.round(performance.now() - started),
        applyQueries: queries,
      });
    }
    const removed = [root, ...children].filter(
      (thread) => f.store.getThread(thread.id)?.deletedAt !== undefined,
    ).length;
    return {
      size,
      removed,
      planMs: rounds.reduce((sum, round) => sum + round.planMs, 0),
      applyMs: rounds.reduce((sum, round) => sum + round.applyMs, 0),
      rounds,
    };
  } finally {
    await f.close();
  }
}

for (const size of sizes) process.stdout.write(`${JSON.stringify(await measure(size))}\n`);
