import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { expect, test } from "vitest";
import { spadeServicePlan } from "./spade-plan.ts";
import { localSpadeSwapPorts } from "./spade-swap-ports.ts";

/** A temp ACE_HOME with Spade's ports over it; nothing here runs or reaches a service. */
async function home(onTestFinished: (fn: () => Promise<void>) => void) {
  const root = await mkdtemp(join(tmpdir(), "ace-spade-swap-ports-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const ports = localSpadeSwapPorts({
    home: root,
    plan: spadeServicePlan(root, "linux", { userHome: root }),
    source: join(root, "spade-server"),
    version: "0.5.0",
  });
  const snapshotDir = join(root, ".spade-update-snapshot");
  const leftSnapshot = async (text: string) => {
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, "spade.sqlite"), text);
    return join(snapshotDir, "spade.sqlite");
  };
  const record = join(root, ".spade-update-swap.json");
  return { root, ports, leftSnapshot, record, data: join(root, "spade") };
}

test.for<[string, string]>([
  ["isn't JSON", "{not json"],
  ["doesn't fit the schema", JSON.stringify({ to: 5 })],
])(
  "a swap record that %s is set aside, its snapshot protected, and updates go on",
  async ([, text], { onTestFinished }) => {
    const { ports, leftSnapshot, record, data } = await home(onTestFinished);
    await leftSnapshot("pre-swap");
    await writeFile(record, text);
    expect(await ports.pendingSwap()).toBeUndefined();
    expect(await readFile(`${record}.unreadable-1`, "utf8")).toBe(text);
    expect(await readFile(join(data, "spade.sqlite.before-unknown"), "utf8")).toBe("pre-swap");
    // The next update's snapshot can't replace it, and the record no longer blocks anything.
    const db = new DatabaseSync(join(data, "spade.sqlite"));
    db.exec("CREATE TABLE t (x)");
    db.close();
    expect(await ports.snapshot()).toBeDefined();
    expect(await readFile(join(data, "spade.sqlite.before-unknown"), "utf8")).toBe("pre-swap");
    expect(await ports.pendingSwap()).toBeUndefined();
  },
);

test("a swap record that can't be read at all is set aside too", async ({ onTestFinished }) => {
  const { ports, record } = await home(onTestFinished);
  await mkdir(record);
  expect(await ports.pendingSwap()).toBeUndefined();
  expect(existsSync(record)).toBe(false);
  expect(existsSync(`${record}.unreadable-1`)).toBe(true);
});

test("a swap whose snapshot was moved to safety before a crash goes on from the moved copy", async ({
  onTestFinished,
}) => {
  const { ports, leftSnapshot } = await home(onTestFinished);
  const snapshot = await leftSnapshot("pre-swap");
  await ports.recordSwap({ from: "0.4.0", to: "0.5.0", snapshot });
  const kept = await ports.keepSnapshot(snapshot, "0.5.0");
  // The updater died here, before clearing the record.
  expect(await ports.pendingSwap()).toEqual({ from: "0.4.0", to: "0.5.0", snapshot: kept });
  expect(await ports.keepSnapshot(snapshot, "0.5.0")).toBe(kept);
  expect(await ports.keepSnapshot(kept, "0.5.0")).toBe(kept);
  expect(await readFile(kept, "utf8")).toBe("pre-swap");
});

test("a swap whose snapshot was already removed no longer names it", async ({ onTestFinished }) => {
  const { ports, leftSnapshot } = await home(onTestFinished);
  const snapshot = await leftSnapshot("pre-swap");
  await ports.recordSwap({ from: "0.4.0", to: "0.5.0", snapshot });
  await ports.removeSnapshot(snapshot);
  expect(await ports.pendingSwap()).toEqual({ from: "0.4.0", to: "0.5.0", snapshot: undefined });
});

test("pruning keeps the newest two protected copies and any a swap record still needs", async ({
  onTestFinished,
}) => {
  const { ports, leftSnapshot, data } = await home(onTestFinished);
  const snapshot = await leftSnapshot("needed");
  await ports.recordSwap({ from: "0.1.0", to: "0.2.0", snapshot });
  // The oldest copy, which the record (an updater that died before clearing it) still names.
  const needed = await ports.keepSnapshot(snapshot, "0.2.0");
  const others = ["0.3.0", "0.4.0", "0.5.0"].map((v) => join(data, `spade.sqlite.before-${v}`));
  for (const [n, path] of [needed, ...others].entries()) {
    if (path !== needed) await writeFile(path, "copy");
    await utimes(path, 1_000 + n, 1_000 + n);
  }
  await writeFile(join(data, "spade.sqlite"), "live");
  await ports.pruneKeptSnapshots();
  expect([needed, ...others].map((path) => existsSync(path))).toEqual([true, false, true, true]);
  expect(existsSync(join(data, "spade.sqlite"))).toBe(true);
});

test("a new snapshot moves a leftover one to safety instead of deleting it", async ({
  onTestFinished,
}) => {
  const { ports, leftSnapshot, data } = await home(onTestFinished);
  await leftSnapshot("left by a crash");
  await mkdir(data, { recursive: true });
  const db = new DatabaseSync(join(data, "spade.sqlite"));
  db.exec("CREATE TABLE t (x)");
  db.close();
  expect(await ports.snapshot()).toBeDefined();
  expect(await readFile(join(data, "spade.sqlite.before-unknown"), "utf8")).toBe("left by a crash");
});
