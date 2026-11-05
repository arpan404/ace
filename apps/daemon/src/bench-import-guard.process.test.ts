import { join } from "node:path";
import { expect, test } from "vitest";
import { checkIdleImports } from "../bench/idle-imports.ts";

/**
 * The perf gate's idle import guard on Bun, against a stand-in daemon (bench/fixtures) whose
 * workers it starts: Bun gives workers no preload of their parent's, so the guard must reach
 * them through ace's worker factory and refuse to pass when it can't.
 */
const entry = join(import.meta.dirname, "../bench/fixtures/worker-daemon.ts");
const guard = (...kinds: string[]) => checkIdleImports({ entry, args: kinds, settleMs: 300 });

test("workers ace's factory started, live or retired, pass the guard", async () => {
  await expect(guard("clean", "retired", "clean")).resolves.toBeUndefined();
});

test("a forbidden package loaded in a worker at idle fails the import guard", async () => {
  await expect(guard("clean", "import")).rejects.toThrow(/Modules loaded at idle:\nsharp: /);
});

test("an unwatched worker beside a watched one fails the guard as not measured", async () => {
  await expect(guard("clean", "unwatched")).rejects.toThrow(
    /not measured \(worker 2 started past ace's worker factory\)/,
  );
});

test("a live unwatched worker after a watched one retired fails the guard as not measured", async () => {
  await expect(guard("retired", "unwatched")).rejects.toThrow(
    /not measured \(worker 2 started past ace's worker factory\)/,
  );
});

test("an unwatched worker that already retired still fails the guard as not measured", async () => {
  await expect(guard("clean", "unwatched-retired")).rejects.toThrow(
    /not measured \(worker 2 started past ace's worker factory\)/,
  );
});
