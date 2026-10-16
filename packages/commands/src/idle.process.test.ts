import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { CommandLibrary } from "./index.ts";

test("eight quiet workspaces share one sleeping recovery timer and emit no catalog changes", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-command-idle-")));
  let pending: { run(): void; delay: number } | undefined;
  let rearmed: (() => void) | undefined;
  const library = new CommandLibrary({
    aceHome: join(home, "ace"),
    instances: [],
    now: () => 0,
    context: (thread) => ({ workspace: join(home, thread), provider: "codex", instance: "codex" }),
    extras: async () => [],
    recoveryTimer(run, delay) {
      expect(pending).toBeUndefined();
      const lease = { run, delay };
      pending = lease;
      rearmed?.();
      return () => {
        if (pending === lease) pending = undefined;
      };
    },
  });
  try {
    for (let i = 0; i < 8; i++) {
      const path = join(home, String(i), ".ace/prompts");
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "review.md"), "Review");
      await library.list(String(i), "review", 10);
    }
    // Allow real filesystem discovery and provider metadata to settle.
    for (let i = 0; i < 8; i++) {
      while ((await library.listCatalog(String(i))).stale) await setImmediate();
    }
    const changes: string[] = [];
    library.subscribeCatalog(() => changes.push("changed"));
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      const tick = pending;
      if (!tick) throw new Error("Missing recovery wake");
      delays.push(tick.delay);
      pending = undefined;
      const next = Promise.withResolvers<void>();
      rearmed = next.resolve;
      tick.run();
      await next.promise;
      rearmed = undefined;
    }
    expect(changes).toEqual([]);
    expect(delays.at(-1)).toBeGreaterThan((delays[0] ?? 0) * 8);
    // Normal edits still wake through native watchers while recovery is sleeping.
    const edited = Promise.withResolvers<void>();
    library.subscribeCatalog(() => edited.resolve());
    await writeFile(join(home, "7/.ace/prompts/review.md"), "Changed review");
    await edited.promise;
    const command = (await library.list("7", "review", 10)).commands.find(
      (c) => c.name === "review" && c.namespace === "prompt",
    );
    if (!command) throw new Error("Missing edited command");
    expect(await library.resolve("7", command.id, {}, [])).toMatchObject({
      ok: true,
      plan: { text: "Changed review" },
    });
  } finally {
    await library.close();
    expect(pending).toBeUndefined();
    await rm(home, { recursive: true, force: true });
  }
});
