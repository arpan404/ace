import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository } from "./test-repo.ts";

test("changed files preserve counts, binary markers and renames for paths containing tabs", async () => {
  const root = await repository({
    "same\ttext": "old\n",
    "same\tbinary": Buffer.from([0, 1]),
    "old\tname": "rename\n",
  });
  const service = new GitService();
  try {
    await put(root, "same\ttext", "new\nsecond\n");
    await put(root, "same\tbinary", Buffer.from([0, 2, 3]));
    await git(root, "mv", "old\tname", "new\tname");
    expect((await service.changedFiles(root)).files).toEqual([
      {
        path: "new\tname",
        from: "old\tname",
        status: "renamed",
        additions: 0,
        deletions: 0,
        binary: false,
      },
      { path: "same\tbinary", status: "modified", additions: 0, deletions: 0, binary: true },
      { path: "same\ttext", status: "modified", additions: 2, deletions: 1, binary: false },
    ]);
    const diff = await service.diff({
      worktree: root,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "working-tree" },
    });
    expect(
      diff.entries.map(({ path, additions, deletions, binary }) => ({
        path,
        additions,
        deletions,
        binary,
      })),
    ).toEqual([
      { path: "new\tname", additions: 0, deletions: 0, binary: false },
      { path: "same\tbinary", additions: 0, deletions: 0, binary: true },
      { path: "same\ttext", additions: 2, deletions: 1, binary: false },
    ]);
  } finally {
    await service.close();
  }
});
