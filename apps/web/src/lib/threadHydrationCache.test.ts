import {
  ProjectId,
  ThreadId,
  TurnId,
  MessageId,
  type OrchestrationReadModel,
} from "@ace/contracts";
import { describe, expect, it, vi } from "vitest";

import { __resetMemoryPressureStateForTests } from "./memoryPressure";
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
    latestProposedPlanSummary: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
    kind: overrides.kind ?? "coding",
  };
}

function setPerformanceMemory(usedBytes: number, limitBytes: number): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(performance, "memory");
  Object.defineProperty(performance, "memory", {
    configurable: true,
    value: {
      usedJSHeapSize: usedBytes,
      jsHeapSizeLimit: limitBytes,
    },
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(performance, "memory", descriptor);
      return;
    }
    Reflect.deleteProperty(performance, "memory");
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

  it("evicts least-recently-used hydrated threads when the memory budget is exceeded", async () => {
    const threadOneId = ThreadId.makeUnsafe("thread-1");
    const threadTwoId = ThreadId.makeUnsafe("thread-2");
    const fetchThread = vi.fn(async (threadId: ThreadId) =>
      makeThread({
        id: threadId,
        messages: [
          {
            id: MessageId.makeUnsafe(`message-${threadId}`),
            role: "user",
            text: "x".repeat(700_000),
            turnId: TurnId.makeUnsafe(`turn-${threadId}`),
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );
    const cache = createThreadHydrationCache(fetchThread, {
      maxEntries: 16,
      maxMemoryBytes: 1024 * 1024,
    });

    await cache.hydrate(threadOneId, { expectedUpdatedAt: NOW });
    await cache.hydrate(threadTwoId, { expectedUpdatedAt: NOW });
    await cache.hydrate(threadOneId, { expectedUpdatedAt: NOW });

    expect(fetchThread).toHaveBeenCalledTimes(3);
  });

  it("starts immediate prefetches without waiting for background scheduling", async () => {
    const fetchThread = vi.fn(async () => makeThread());
    const cache = createThreadHydrationCache(fetchThread);

    cache.prefetch(THREAD_ID, { priority: "immediate" });
    await Promise.resolve();

    expect(fetchThread).toHaveBeenCalledTimes(1);
    expect(cache.read(THREAD_ID, NOW)?.id).toBe(THREAD_ID);
  });

  it("skips background prefetch when live memory pressure is elevated", async () => {
    const restorePerformanceMemory = setPerformanceMemory(800, 1_000);
    __resetMemoryPressureStateForTests();

    try {
      const fetchThread = vi.fn(async () => makeThread());
      const cache = createThreadHydrationCache(fetchThread);

      cache.prefetch(THREAD_ID);
      await Promise.resolve();

      expect(fetchThread).not.toHaveBeenCalled();
    } finally {
      restorePerformanceMemory();
      __resetMemoryPressureStateForTests();
    }
  });

  it("does not retain newly hydrated threads in cache while memory pressure is high", async () => {
    const restorePerformanceMemory = setPerformanceMemory(860, 1_000);
    __resetMemoryPressureStateForTests();

    try {
      const fetchThread = vi.fn(async () => makeThread());
      const cache = createThreadHydrationCache(fetchThread);

      await cache.hydrate(THREAD_ID, { expectedUpdatedAt: NOW });

      expect(cache.read(THREAD_ID, NOW)).toBeNull();
      expect(fetchThread).toHaveBeenCalledTimes(1);
    } finally {
      restorePerformanceMemory();
      __resetMemoryPressureStateForTests();
    }
  });
});
