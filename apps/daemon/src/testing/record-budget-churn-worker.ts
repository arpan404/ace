import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { RecordBudget } from "../engine/record-cache.ts";

// Run in a fresh Node process: reports the heap one long-lived section keeps after caching far
// more distinct keys than the budget holds, and how many entries clearing it found.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const keys = Number(process.argv[2] ?? 200_000);
const budget = new RecordBudget(64, 1 << 20);
const section = budget.section<number>();
const other = budget.section<number>();
const record = (value: number) => ({ value, json: "1", bytes: 1 });
const key = (i: number) => `item-01a170ba-b13a-773b-9a74-${String(i).padStart(12, "0")}`;
for (let i = 0; i < 100; i++) section.set(key(i), record(i), 1);
gc();
gc();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < keys; i++) section.set(key(i), record(i), 1);
// Another section's entries push the long-lived one's out too.
for (let i = 0; i < 64; i++) other.set(key(i), record(i), 1);
gc();
gc();
const after = process.memoryUsage().heapUsed;
const resident = Array.from({ length: keys }, (_, i) => section.get(key(i))).filter(Boolean).length;
section.clear();
process.stdout.write(JSON.stringify({ keys, resident, retainedIncrease: after - before }));
