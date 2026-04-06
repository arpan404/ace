import { ProjectId, ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { LEAN_SNAPSHOT_RECOVERY_INPUT, resolveWelcomeBootstrapPlan } from "./bootstrapRecovery";

const projectId = ProjectId.makeUnsafe("project-1");
const threadId = ThreadId.makeUnsafe("thread-1");

const payload = {
  cwd: "/tmp/workspace",
  projectName: "workspace",
  bootstrapProjectId: projectId,
  bootstrapThreadId: threadId,
} as const;

describe("bootstrapRecovery", () => {
  it("always requests a lean snapshot during recovery", () => {
    expect(LEAN_SNAPSHOT_RECOVERY_INPUT).toEqual({
      hydrateThreadId: null,
    });
  });

  it("bootstraps from snapshot and navigates from the root route on initial welcome", () => {
    expect(
      resolveWelcomeBootstrapPlan({
        bootstrapComplete: false,
        pathname: "/",
        handledBootstrapThreadId: null,
        payload,
      }),
    ).toEqual({
      shouldBootstrapFromSnapshot: true,
      expandProjectId: projectId,
      navigateToThreadId: threadId,
    });
  });

  it("skips redundant snapshot bootstrap after the client store is already bootstrapped", () => {
    expect(
      resolveWelcomeBootstrapPlan({
        bootstrapComplete: true,
        pathname: `/${threadId}`,
        handledBootstrapThreadId: null,
        payload,
      }),
    ).toEqual({
      shouldBootstrapFromSnapshot: false,
      expandProjectId: projectId,
      navigateToThreadId: null,
    });
  });

  it("does not navigate again when the bootstrap thread was already handled", () => {
    expect(
      resolveWelcomeBootstrapPlan({
        bootstrapComplete: false,
        pathname: "/",
        handledBootstrapThreadId: threadId,
        payload,
      }),
    ).toEqual({
      shouldBootstrapFromSnapshot: true,
      expandProjectId: projectId,
      navigateToThreadId: null,
    });
  });
});
