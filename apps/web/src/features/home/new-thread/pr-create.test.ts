import { expect, test } from "vitest";
import { createPayload } from "./use-create-thread.ts";

test("a PR task keeps the chosen account and prompt, pins its identity and head, and always uses an isolated worktree", () => {
  const pullRequest = {
    ref: {
      repository: { forge: "github", host: "github.com", owner: "octo", name: "ace" },
      number: 7,
    },
    headSha: "a".repeat(40),
  } as const;
  const result = createPayload({
    project: "project",
    scope: { provider: "codex", instance: "account" },
    model: "model",
    mode: "local",
    base: { ref: "main", remote: "origin" },
    effort: undefined,
    text: "My review task",
    pullRequest,
  });
  expect(result).toMatchObject({
    provider: "codex",
    accountId: "account",
    model: "model",
    mode: "worktree",
    pullRequest,
    input: [{ type: "text", text: "My review task" }],
  });
  expect(result.base).toBeUndefined();
  expect(result.baseBranch).toBeUndefined();
});
