import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar } from "./test-repo.ts";

test("branch cleanup removes an unchanged unused branch but preserves moved and checked-out refs", async () => {
  const service = new GitService(),
    repo = await repository();
  try {
    const initial = await scalar(repo, "rev-parse", "HEAD");
    const path = join(dirname(repo), "handoff");
    await service.createWorktree({ repo, path, baseRef: "HEAD", branch: "handoff" });
    await expect(
      service.deleteBranch({ repo, branch: "handoff", expectedHead: initial }),
    ).rejects.toMatchObject({ code: "restore_collision" });
    expect(await scalar(repo, "rev-parse", "handoff")).toBe(initial);
    await service.removeWorktree({ repo, path });
    await put(repo, "tracked.txt", "changed\n");
    await git(repo, "commit", "-am", "changed");
    const changed = await scalar(repo, "rev-parse", "HEAD");
    await git(repo, "branch", "-f", "handoff", changed);
    await expect(
      service.deleteBranch({ repo, branch: "handoff", expectedHead: initial }),
    ).rejects.toMatchObject({ code: "restore_collision" });
    expect(await scalar(repo, "rev-parse", "handoff")).toBe(changed);
    await service.deleteBranch({ repo, branch: "handoff", expectedHead: changed });
    expect(await scalar(repo, "branch", "--list", "handoff")).toBe("");
  } finally {
    await service.close();
  }
});
