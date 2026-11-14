import type { ThreadDetails } from "@ace/protocol";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { z } from "zod";

/*
 * Threads for the Work sheet (`UITests/WorkUITests.swift`), one fresh thread per test so they pass
 * in any order: `clean` is a finished thread in its local checkout on main with one linked pull
 * request (the fixture's branches are main and develop); `stuck` is a worktree whose setup script
 * failed and holds the first message; `locked` is a thread whose message an earlier daemon's
 * stale Git lock stopped; `many` is `clean` with 45 linked pull requests in a project with 450 more
 * branches, for paging both lists. No provider CLI runs.
 */

export const WorkScenario = z.enum(["clean", "stuck", "locked", "many"]);
export type WorkScenario = z.infer<typeof WorkScenario>;

const repository = { forge: "github", host: "github.com", owner: "arpan404", name: "ace" } as const;

const linkedPr = (number: number, title: string) => ({
  number,
  repo: { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const,
  url: `https://github.com/acme/ace/pull/${number}`,
  state: "open" as const,
  title,
  updatedAt: number,
});

export function seedWork(
  daemon: FakeDaemon,
  scenario: WorkScenario,
  threadId: string,
  details: (branch: string) => ThreadDetails,
): void {
  const base: ThreadDetails = {
    ...details("main"),
    mode: scenario === "stuck" ? "worktree" : "local",
    worktree:
      scenario === "stuck" ? `/tmp/ace-ios-spike/worktrees/${threadId}` : "/tmp/ace-ios-spike",
    baseBranch: "main",
    head: "4".repeat(40),
    ahead: 0,
    behind: 0,
    repository,
  };
  const titles: Record<WorkScenario, string> = {
    clean: "Tidy the queue retries",
    stuck: "Start on the release branch",
    locked: "Rename the cleanup fence",
    many: "Sweep the release branches",
  };
  if (scenario === "many")
    daemon.workspace.git.addBranches(
      "ace",
      Array.from({ length: 450 }, (_, index) => `release/r${index + 1}`),
    );
  daemon.createThread({
    hasSentMessage: true,
    id: threadId,
    workspaceId: "ace",
    title: titles[scenario],
    provider: "codex",
    details: {
      ...base,
      ...(scenario === "clean"
        ? {
            // A pull request the fixture's GitHub knows, so its page opens in the app.
            linkedPrs: [{ ...linkedPr(233, "Keep the composer draft per project"), updatedAt: 1 }],
          }
        : {}),
      ...(scenario === "many"
        ? {
            linkedPrs: Array.from({ length: 45 }, (_, index) =>
              linkedPr(300 + index, `Release sweep ${index + 1}`),
            ),
          }
        : {}),
      ...(scenario === "stuck"
        ? {
            worktreeSetup: {
              state: "failed" as const,
              details: ["$ bun install", "error: lockfile had changes, but lockfile is frozen"],
              at: 1,
            },
          }
        : {}),
    },
  });
  daemon.apply(threadId, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Keep going on this branch."),
    facts.endTurn("root"),
  ]);
  if (scenario === "stuck") daemon.holdQueue(threadId, "not_sent");
  if (scenario === "locked")
    daemon.holdQueue(threadId, "not_sent", {
      title: "Git is locked",
      code: "git_quarantined",
    });
}
