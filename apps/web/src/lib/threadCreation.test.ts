import { describe, expect, it } from "vitest";

import { resolveThreadCreationOptions } from "./threadCreation";

describe("resolveThreadCreationOptions", () => {
  it("inherits branch and worktree context for a new thread", () => {
    expect(
      resolveThreadCreationOptions("new-thread", {
        activeDraftThread: null,
        activeThread: {
          branch: "feature/menu",
          worktreePath: "/tmp/worktrees/menu",
        },
        defaultNewThreadEnvMode: "local",
      }),
    ).toEqual({
      branch: "feature/menu",
      worktreePath: "/tmp/worktrees/menu",
      envMode: "worktree",
    });
  });

  it("prefers the active draft env mode when one exists", () => {
    expect(
      resolveThreadCreationOptions("new-thread", {
        activeDraftThread: {
          branch: "draft-branch",
          envMode: "local",
          worktreePath: null,
        },
        activeThread: {
          branch: "feature/menu",
          worktreePath: "/tmp/worktrees/menu",
        },
        defaultNewThreadEnvMode: "worktree",
      }),
    ).toEqual({
      branch: "feature/menu",
      worktreePath: "/tmp/worktrees/menu",
      envMode: "local",
    });
  });

  it("uses the sidebar default env mode for new local threads", () => {
    expect(
      resolveThreadCreationOptions("new-local-thread", {
        activeDraftThread: {
          branch: "draft-branch",
          envMode: "worktree",
          worktreePath: "/tmp/worktrees/draft",
        },
        activeThread: {
          branch: "feature/menu",
          worktreePath: "/tmp/worktrees/menu",
        },
        defaultNewThreadEnvMode: "local",
      }),
    ).toEqual({
      envMode: "local",
    });
  });
});
