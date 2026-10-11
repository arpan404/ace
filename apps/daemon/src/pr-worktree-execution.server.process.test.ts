import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CommandId, ThreadId } from "@ace/protocol";
import { until } from "./projects-test-support.ts";
import { prDaemon, run } from "./pr-worktree-test-support.ts";
import { maliciousPr, lfsPointer } from "./pr-worktree-execution-test-support.ts";

for (const attack of ["smudge", "lfs", "fsmonitor"] as const) {
  test(`fork PR preparation never executes the configured ${attack} program`, async () => {
    const security = maliciousPr(attack);
    const d = await prDaemon(security.options);
    try {
      const id = ThreadId.parse(`safe-${attack}`);
      expect(await d.create(id)).toMatchObject({ ok: true });
      await d.h.engine.flush();
      const path = d.h.store.getThread(id)?.details?.worktree ?? "";
      expect(await run(path, "rev-parse", "HEAD")).toBe(d.head);
      expect(await readFile(join(path, "pr.txt"), "utf8")).toBe("PR-only content\n");
      expect(await readFile(join(path, "z-lfs.txt"), "utf8")).toBe(lfsPointer);
      await writeFile(join(path, "pr.txt"), "An unsent edit\n");
      expect((await d.runtime.git.status(path)).unstaged).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "pr.txt" })]),
      );
      await d.reopen();
      expect((await d.runtime.git.status(path)).unstaged).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "pr.txt" })]),
      );
      await security.expectNoExecution();
    } finally {
      await d.close();
    }
  });
}

test("failed final verification cleans the fork checkout without executing filters, fsmonitor or its post-index-change hook", async () => {
  const security = maliciousPr("all", "moved");
  const d = await prDaemon(security.options);
  try {
    const before = await d.trees();
    expect(await d.create("failed-safe-verification")).toMatchObject({
      ok: false,
      error: "forge_conflict",
    });
    expect(await d.trees()).toBe(before);
    expect(d.h.inputs).toHaveLength(0);
    await security.expectNoExecution();
  } finally {
    await d.close();
  }
});

test("cancelling after fork checkout cleans its temporary index without executing filters, fsmonitor or its post-index-change hook", async () => {
  const security = maliciousPr("all", "waiting");
  const d = await prDaemon(security.options);
  try {
    const before = await d.trees();
    const verifying = security.waitForVerification(d.client, "cancel-safe-checkout");
    d.client.send({ type: "command", command: d.draft("cancel-safe-checkout") });
    await verifying;
    d.client.send({
      type: "worktree.creation.request",
      requestId: "cancel",
      commandId: CommandId.parse("cancel-safe-checkout"),
      action: "cancel",
    });
    expect(
      await until(d.client, (message) => message.type === "worktree.creation.result"),
    ).toMatchObject({ ok: true });
    expect(
      await until(
        d.client,
        (message) =>
          message.type === "commandResult" && message.commandId === "cancel-safe-checkout",
      ),
    ).toMatchObject({ ok: false, error: "worktree_cancelled" });
    expect(await d.trees()).toBe(before);
    await security.expectNoExecution();
  } finally {
    await d.close();
  }
});
