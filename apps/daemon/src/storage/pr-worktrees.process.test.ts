import { access } from "node:fs/promises";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { prDaemon } from "../pr-worktree-test-support.ts";
import { StorageService } from "./service.ts";

for (const mode of ["new task", "existing task"] as const) {
  test(`a PR worktree for a ${mode} is managed and protected by its actual live owner`, async () => {
    const d = await prDaemon();
    let storage: StorageService | undefined;
    try {
      const id = mode === "new task" ? ThreadId.parse("pr-cleanup-owner") : await d.h.create();
      expect(
        mode === "new task" ? await d.create(id) : await d.work(id, "select-pr-cleanup"),
      ).toMatchObject({ ok: true });
      await d.h.engine.flush();
      const path = d.h.store.getThread(id)?.details?.worktree;
      if (!path) throw new Error("Missing PR checkout");
      storage = new StorageService({
        root: d.directory,
        store: d.h.store,
        services: { workspaceActions: d.runtime, engine: d.h.engine },
        now: () => Date.now() + 200 * 86400000,
        id: () => "pr-cleanup",
      });
      const plan = await storage.plan("owner", {
        op: "cleanup.plan",
        kinds: ["worktrees"],
        forceItems: [],
      });
      const item = plan.items.find((entry) => entry.label === path);
      expect(item?.disposition).toBe("protect");
      expect(item?.threadIds).toContain(id);
      expect(item?.reasons).toContain("live_thread");
      await storage.apply("owner", plan.id, plan.revision);
      await access(path);
    } finally {
      await storage?.close();
      await d.close();
    }
  });
}
