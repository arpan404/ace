import { expect, it } from "vitest";
import { GitService } from "./index.ts";
import { repository } from "./test-repo.ts";

it("evicted checkpoint counters reload durable sequences without growing the cache", async () => {
  const root = await repository();
  const service = new GitService({ checkpointCounterCacheSize: 2 });
  try {
    const first = await service.createCheckpoint({
      worktree: root,
      threadId: "first",
      label: "one",
    });
    for (const threadId of ["second", "third"])
      await service.createCheckpoint({ worktree: root, threadId, label: threadId });
    expect(service.resourceUsage().checkpointCounters).toBeLessThanOrEqual(2);
    const next = await service.createCheckpoint({
      worktree: root,
      threadId: "first",
      label: "two",
    });
    expect(next.sequence).toBe(first.sequence + 1);
    expect(next.id).not.toBe(first.id);
    expect(
      (await service.listCheckpoints({ repo: root, threadId: "first" })).map((c) => c.id),
    ).toEqual([first.id, next.id]);
    expect(service.resourceUsage().checkpointCounters).toBeLessThanOrEqual(2);
  } finally {
    await service.close();
  }
});
