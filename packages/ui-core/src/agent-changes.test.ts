import { expect, test } from "vitest";
import { changesByAgent } from "./agent-changes.ts";

const file = (path: string, added = 1, removed = 0) => ({ path, added, removed });

test("two agents changing the same file in one checkout are flagged on both", () => {
  const result = changesByAgent([
    { agentId: "a", worktree: "/repo", files: [file("/repo/src/a.ts"), file("b.ts")] },
    { agentId: "b", worktree: "/repo/", files: [file("src/a.ts", 4, 2)] },
  ]);
  expect(result.conflicts).toEqual([{ worktree: "/repo", path: "src/a.ts", agents: ["a", "b"] }]);
  const [worktree] = result.worktrees;
  expect(worktree?.agents.map((agent) => agent.files.map((f) => [f.path, f.shared]))).toEqual([
    [
      ["src/a.ts", true],
      ["b.ts", false],
    ],
    [["src/a.ts", true]],
  ]);
});

test("the same path changed in different worktrees is not a conflict", () => {
  const result = changesByAgent([
    { agentId: "a", worktree: "/repo", files: [file("src/a.ts")] },
    { agentId: "b", worktree: "/tmp/wt", files: [file("/tmp/wt/src/a.ts")] },
  ]);
  expect(result.conflicts).toEqual([]);
  expect(result.worktrees.map((group) => group.worktree)).toEqual(["/repo", "/tmp/wt"]);
});

test("agents that changed nothing are left out", () => {
  const result = changesByAgent([
    { agentId: "a", worktree: "/repo", files: [] },
    { agentId: "b", worktree: "/repo", files: [file("x.ts")] },
  ]);
  expect(result.worktrees[0]?.agents.map((agent) => agent.agentId)).toEqual(["b"]);
});
