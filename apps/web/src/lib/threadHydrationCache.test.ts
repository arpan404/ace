import {
  ProjectId,
  ThreadId,
  TurnId,
  MessageId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { createThreadHydrationCache } from "./threadHydrationCache";

const NOW = "2026-04-05T00:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.makeUnsafe("message-1"),
        role: "user",
        text: "Hello",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [],
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

describe("createThreadHydrationCache", () => {
  it("returns cached hydrated threads when updatedAt matches", async () => {
    const fetchThread = vi.fn(async () => makeThread());
    const cache = createThreadHydrationCache(fetchThread);

    const first = await cache.hydrate(THREAD_ID, { expectedUpdatedAt: NOW });
    const second = await cache.hydrate(THREAD_ID, { expectedUpdatedAt: NOW });

    expect(second).toBe(first);
    expect(fetchThread).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent hydration requests for the same thread", async () => {
    let resolveThread!: (thread: OrchestrationReadModel["threads"][number]) => void;
    const fetchThread = vi.fn(
      () =>
        new Promise<OrchestrationReadModel["threads"][number]>((resolve) => {
          resolveThread = resolve;
        }),
    );
    const cache = createThreadHydrationCache(fetchThread);

    const firstRequest = cache.hydrate(THREAD_ID);
    const secondRequest = cache.hydrate(THREAD_ID);
    resolveThread(makeThread());

    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(second).toBe(first);
    expect(fetchThread).toHaveBeenCalledTimes(1);
  });

  it("treats updatedAt mismatches as stale cache entries", async () => {
    const fetchThread = vi
      .fn<() => Promise<OrchestrationReadModel["threads"][number]>>()
      .mockResolvedValueOnce(makeThread())
      .mockResolvedValueOnce(
        makeThread({
          updatedAt: "2026-04-05T00:00:10.000Z",
        }),
      );
    const cache = createThreadHydrationCache(fetchThread);

    const initial = await cache.hydrate(THREAD_ID, { expectedUpdatedAt: NOW });
    const refreshed = await cache.hydrate(THREAD_ID, {
      expectedUpdatedAt: "2026-04-05T00:00:10.000Z",
    });

    expect(refreshed).not.toBe(initial);
    expect(refreshed.updatedAt).toBe("2026-04-05T00:00:10.000Z");
    expect(fetchThread).toHaveBeenCalledTimes(2);
  });
});
