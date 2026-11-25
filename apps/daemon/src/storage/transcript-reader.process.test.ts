import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { StorageInventory } from "./inventory.ts";
import { storageFixture } from "./test-support.ts";

const fixtures: Awaited<ReturnType<typeof storageFixture>>[] = [];
const inventories: StorageInventory[] = [];
afterEach(async () => {
  for (const inventory of inventories.splice(0)) await inventory.close();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

const reply = `process.on("message", (message) => {
  if (message && message.op === "transcripts")
    process.send({ kind: "transcripts", bytes: message.threads.map(() => 11) });
});`;

/** A process boundary whose children run the given script instead of the real worker. */
function spawnWorkers(script: string) {
  const workers: ChildProcess[] = [];
  return {
    workers,
    spawn() {
      const worker = spawn(process.execPath, ["-e", script], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      workers.push(worker);
      return worker;
    },
  };
}

function inventoryFor(
  f: Awaited<ReturnType<typeof storageFixture>>,
  spawnWorker: () => ChildProcess,
) {
  const inventory = new StorageInventory(
    { root: f.root, now: f.now, id: () => "inventory", store: f.store, services: f.services },
    spawnWorker,
  );
  inventories.push(inventory);
  return inventory;
}

test("a concurrent read waits for the one in flight instead of failing", async () => {
  const f = await storageFixture();
  fixtures.push(f);
  const tracking = spawnWorkers(reply);
  const inventory = inventoryFor(f, tracking.spawn);
  const first = f.thread("first").id;
  const second = f.thread("second").id;
  const measured = await Promise.all([inventory.thread(first), inventory.thread(second)]);
  expect(measured.map((candidate) => candidate?.bytes)).toEqual([11, 11]);
  expect(tracking.workers).toHaveLength(1);
});
