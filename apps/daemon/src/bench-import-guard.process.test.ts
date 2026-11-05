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

test("a forbidden package loaded in a worker at idle fails the import guard", async () => {
  await expect(guard("clean", "import")).rejects.toThrow(/Modules loaded at idle:\nsharp: /);
});

test("a worker the guard's hook never ran in fails it as not measured, never as a pass", async () => {
  await expect(guard("unwatched")).rejects.toThrow(/Idle imports in workers: not measured/);
});
