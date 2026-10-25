import type { Fact } from "@ace/core";
import { ThreadId, type ThreadStatus } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { message, rootAgent, turn } from "./facts.ts";

const cwd = "/Users/dev/acme";
export const queuedDelegationIds = {
  parent: "thread-queued-parent",
  running: "thread-queued-running",
  queued: "thread-queued-waiting",
} as const;

const task = [
  "Remove the unused model picker code from the iOS client.",
  "- Delete ModelPickerSheet and its previews.",
  "- Keep the bridge's model list: the composer still reads it.",
].join("\n");

/**
 * A parent that delegated two children through ace with one run slot free: the first runs, the
 * second waits in the daemon's launch queue (phase `created`, status waiting on queue) until the
 * first finishes. The queued child's own thread holds only its task.
 */
export function queuedDelegation(): Scenario[] {
  const launch = (
    child: string,
    title: string,
    phase: "created" | "running",
    status: ThreadStatus,
    queue?: { slotLimit: number; slotsInUse: number; queuePosition: number },
  ): Fact[] => [
    {
      type: "item.upsert",
      agent: "root",
      item: `launch-${child}`,
      draft: {
        type: "delegation.started",
        origin: "ace",
        childThreadId: ThreadId.parse(child),
        provider: "claude",
        model: "claude-opus-5-5",
        title,
        role: title,
        phase,
        status: queue ? { ...status, ...queue } : status,
        updatedAt: 1000,
        generation: 0,
        complete: false,
        outcome: null,
      },
    },
    {
      type: "agent.seen",
      agent: `child-${child}`,
      parent: "root",
      origin: "ace",
      fidelity: "full",
      native: { provider: "claude", nativeId: child },
      cwd,
      name: title,
    },
    { type: "agent.external", agent: `child-${child}`, threadId: ThreadId.parse(child), status },
  ];
  const parent: Scenario = {
    thread: {
      id: queuedDelegationIds.parent,
      workspaceId: "acme",
      title: "Tidy the iOS client",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 2 * 60_000,
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message("root", "ask", "user", "Split the iOS cleanup across two agents."),
          ...launch(queuedDelegationIds.running, "Clean-iOS-settings", "running", {
            state: "working",
            agents: 1,
          }),
          ...launch(queuedDelegationIds.queued, "Clean-iOS-model-picker", "created", {
            state: "waiting",
            on: "queue",
          },
          { slotLimit: 1, slotsInUse: 1, queuePosition: 1 }),
        ],
      },
    ],
  };
  const running: Scenario = {
    thread: {
      id: queuedDelegationIds.running,
      workspaceId: "acme",
      title: "Clean-iOS-settings",
      provider: "claude",
      parentThreadId: queuedDelegationIds.parent,
    },
    steps: [
      {
        kind: "facts",
        agoMs: 2 * 60_000,
        facts: [
          rootAgent("claude", cwd),
          turn("root", "spawn"),
          message("root", "ask", "user", "Role: Clean-iOS-settings\n\nTask:\nTidy settings."),
        ],
      },
    ],
  };
  const queued: Scenario = {
    thread: {
      id: queuedDelegationIds.queued,
      workspaceId: "acme",
      title: "Clean-iOS-model-picker",
      provider: "claude",
      parentThreadId: queuedDelegationIds.parent,
      queuedLaunch: {
        text: task,
        slotLimit: 1,
        slotsInUse: 1,
        queuePosition: 1,
      },
    },
    steps: [],
  };
  return [parent, running, queued];
}
