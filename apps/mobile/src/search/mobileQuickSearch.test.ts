import { describe, expect, it } from "vitest";
import type { OrchestrationProject, OrchestrationThread } from "@ace/contracts";
import { newProjectId, newThreadId } from "@ace/shared/ids";
import type { HostInstance } from "../hostInstances";
import type { MobileProjectSummary, MobileThreadSummary } from "../orchestration/mobileData";
import { buildMobileQuickSearchItems } from "./mobileQuickSearch";

const now = "2026-05-02T00:00:00.000Z";
const projectId = newProjectId();
const threadId = newThreadId();

function host(overrides: Partial<HostInstance> = {}): HostInstance {
  return {
    id: "host-1",
    name: "Local host",
    wsUrl: "ws://127.0.0.1:3773/ws",
    authToken: "token",
    clientSessionId: "session",
    createdAt: now,
    ...overrides,
  };
}

function project(overrides: Partial<OrchestrationProject> = {}): OrchestrationProject {
  return {
    id: projectId,
    title: "ace",
    workspaceRoot: "/repo/ace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "Fix mobile search",
    modelSelection: { provider: "codex", model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/repo/ace",
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    latestProposedPlanSummary: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function projectSummary(projectValue = project()): MobileProjectSummary {
  return {
    hostId: "host-1",
    hostName: "Local host",
    project: projectValue,
    threads: [],
    liveCount: 0,
    completedCount: 0,
    pendingCount: 0,
    lastActivityAt: now,
  };
}

function threadSummary(threadValue = thread()): MobileThreadSummary {
  return {
    hostId: "host-1",
    hostName: "Local host",
    project: project(),
    thread: threadValue,
    status: { bucket: "waiting", label: "Ready", tone: "accent" },
    preview: "Search the combined mobile surface",
    lastActivityAt: now,
    attentionActivity: null,
    projectTitle: "ace",
  };
}

describe("buildMobileQuickSearchItems", () => {
  it("returns hosts, projects, and threads in mobile navigation order", () => {
    const items = buildMobileQuickSearchItems({
      connectedHostIds: new Set(["host-1"]),
      hosts: [host()],
      projects: [projectSummary()],
      query: "",
      threads: [threadSummary()],
    });

    expect(items.map((item) => item.kind)).toEqual([
      "action",
      "action",
      "action",
      "host",
      "project",
      "thread",
    ]);
    expect(items[3]).toMatchObject({ title: "Local host", subtitle: "Connected host" });
  });

  it("searches titles, paths, host names, and thread previews", () => {
    const baseInput = {
      connectedHostIds: new Set<string>(),
      hosts: [host()],
      projects: [projectSummary()],
      threads: [threadSummary()],
    };

    expect(buildMobileQuickSearchItems({ ...baseInput, query: "pair" })).toHaveLength(1);
    expect(buildMobileQuickSearchItems({ ...baseInput, query: "127.0.0.1" })).toHaveLength(1);
    expect(buildMobileQuickSearchItems({ ...baseInput, query: "/repo/ace" })).toHaveLength(2);
    expect(buildMobileQuickSearchItems({ ...baseInput, query: "combined mobile" })).toHaveLength(1);
    expect(buildMobileQuickSearchItems({ ...baseInput, query: "missing" })).toHaveLength(0);
  });
});
