import { EventId, MessageId, ThreadId, TurnId, type OrchestrationReadModel } from "@ace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeApiMock = vi.hoisted(() => ({
  getThread: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    orchestration: nativeApiMock,
  }),
}));

import {
  fetchThreadTimelineRowsHydration,
  isThreadTimelineRowsFullyHydrated,
  readTimelineRow,
  readTimelineRowsProjection,
  readTimelineRowsWindowProjection,
  primeThreadTimelineRowsMetadataFromReadModelThread,
  primeThreadTimelineRowsMetadataFromReadModelThreads,
  setThreadReadModelObserver,
  startThreadTimelineRowsOpenPrefetch,
  useTimelineModelStore,
} from "./timelineModelStore";

const threadId = ThreadId.makeUnsafe("thread-row-store");
const otherThreadId = ThreadId.makeUnsafe("thread-row-store-other");
const turnId = TurnId.makeUnsafe("turn-row-store");
const messageId = MessageId.makeUnsafe("message-row-store");
const otherMessageId = MessageId.makeUnsafe("message-row-store-other");

function readModelThreadForMetadata(input: {
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly messageCount?: number;
}): OrchestrationReadModel["threads"][number] {
  return {
    id: input.id,
    updatedAt: input.updatedAt,
    messages: Array.from({ length: input.messageCount ?? 0 }, (_, index) => ({
      id: MessageId.makeUnsafe(`metadata-message-${input.id}-${String(index)}`),
      role: "assistant" as const,
      text: `Message ${String(index)}`,
      turnId: null,
      streaming: false,
      sequence: index,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    })),
    activities: [],
    proposedPlans: [],
  } as unknown as OrchestrationReadModel["threads"][number];
}

afterEach(() => {
  useTimelineModelStore.getState().reset();
  setThreadReadModelObserver(null);
  nativeApiMock.getThread.mockReset();
  vi.useRealTimers();
});

describe("timelineModelStore", () => {
  it("batches read-model thread metadata priming into one store write", () => {
    const initialRevision = useTimelineModelStore.getState().revision;
    primeThreadTimelineRowsMetadataFromReadModelThreads([
      readModelThreadForMetadata({
        id: threadId,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      readModelThreadForMetadata({
        id: otherThreadId,
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    ]);

    const stateAfterBatch = useTimelineModelStore.getState();
    expect(stateAfterBatch.revision).toBe(initialRevision + 1);
    expect(stateAfterBatch.metadataByThreadId[threadId]?.totalRows).toBe(0);
    expect(stateAfterBatch.metadataByThreadId[otherThreadId]?.totalRows).toBe(0);

    primeThreadTimelineRowsMetadataFromReadModelThreads([
      readModelThreadForMetadata({
        id: threadId,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      readModelThreadForMetadata({
        id: otherThreadId,
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    ]);

    expect(useTimelineModelStore.getState().revision).toBe(stateAfterBatch.revision);
  });

  it("does not notify subscribers for unchanged active timeline windows", () => {
    const activeWindow = {
      startRowIndex: 8,
      endRowIndexExclusive: 18,
      overscanStartRowIndex: 4,
      overscanEndRowIndexExclusive: 22,
      revision: "rev:window",
    };

    useTimelineModelStore.getState().setActiveWindow(threadId, activeWindow);
    const stateAfterFirstWrite = useTimelineModelStore.getState();
    const listener = vi.fn();
    const unsubscribe = useTimelineModelStore.subscribe(listener);

    try {
      useTimelineModelStore.getState().setActiveWindow(threadId, { ...activeWindow });

      expect(useTimelineModelStore.getState()).toBe(stateAfterFirstWrite);
      expect(listener).not.toHaveBeenCalled();

      useTimelineModelStore.getState().setActiveWindow(threadId, {
        ...activeWindow,
        endRowIndexExclusive: 19,
      });

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("primes local snapshot metadata without deriving timeline rows", () => {
    useTimelineModelStore.getState().primeMetadata({
      threadId,
      revision: "rev:1",
      updatedAt: "2026-01-01T00:00:02.000Z",
      totalRows: 10_000,
      tailStartRowIndex: 9_900,
    });

    const state = useTimelineModelStore.getState();
    expect(state.metadataByThreadId[threadId]?.totalRows).toBe(10_000);
    expect(state.rowIdsByThreadId[threadId]).toBeUndefined();
    expect(readTimelineRowsProjection(threadId).messages).toEqual([]);
    expect(nativeApiMock.getThread).not.toHaveBeenCalled();
  });

  it("patches a single streaming row in place by row id", () => {
    vi.useFakeTimers();
    useTimelineModelStore.getState().patchRow(threadId, {
      id: "message:message-row-store",
      kind: "message",
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      contentVersion: "chunk:1",
      startSourceIndex: 0,
      endSourceIndexExclusive: 1,
      turnId,
      sourceRefs: [
        {
          kind: "message",
          id: "message-row-store",
          createdAt: "2026-01-01T00:00:01.000Z",
          sourceIndex: 0,
          turnId,
          sequence: 1,
        },
      ],
    });
    useTimelineModelStore.getState().patchRow(threadId, {
      id: "message:message-row-store",
      kind: "message",
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
      contentVersion: "chunk:2",
      startSourceIndex: 0,
      endSourceIndexExclusive: 1,
      turnId,
      sourceRefs: [
        {
          kind: "message",
          id: "message-row-store",
          createdAt: "2026-01-01T00:00:01.000Z",
          sourceIndex: 0,
          turnId,
          sequence: 1,
        },
      ],
    });

    expect(useTimelineModelStore.getState().rowIdsByThreadId[threadId]).toEqual([
      "message:message-row-store",
    ]);
    expect(readTimelineRow(threadId, "message:message-row-store")?.contentVersion).toBe("chunk:2");
  });

  it("does not bump timeline revisions for unchanged row patches", () => {
    const row = {
      id: "message:message-row-store",
      kind: "message" as const,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      contentVersion: "chunk:1",
      startSourceIndex: 0,
      endSourceIndexExclusive: 1,
      turnId,
      sourceRefs: [
        {
          kind: "message" as const,
          id: "message-row-store",
          createdAt: "2026-01-01T00:00:01.000Z",
          sourceIndex: 0,
          turnId,
          sequence: 1,
        },
      ],
    };

    useTimelineModelStore.getState().patchRow(threadId, row);
    const stateAfterFirstPatch = useTimelineModelStore.getState();
    useTimelineModelStore
      .getState()
      .patchRow(threadId, { ...row, sourceRefs: [...row.sourceRefs] });

    expect(useTimelineModelStore.getState()).toBe(stateAfterFirstPatch);
    expect(useTimelineModelStore.getState().revisionByThreadId[threadId]).toBe(1);
  });

  it("coalesces live streaming row patches per frame", async () => {
    vi.useFakeTimers();
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow({
      threadId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      entry: {
        kind: "message",
        id: messageId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        sequence: 1,
      },
      message: {
        id: messageId,
        role: "assistant",
        text: "Hel",
        turnId,
        streaming: true,
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
    });
    primeLiveTimelineRow({
      threadId,
      updatedAt: "2026-01-01T00:00:03.000Z",
      entry: {
        kind: "message",
        id: messageId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        sequence: 1,
      },
      message: {
        id: messageId,
        role: "assistant",
        text: "Hello",
        turnId,
        streaming: true,
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    });

    expect(readTimelineRowsProjection(threadId).messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(16);

    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "Hello",
    ]);
    expect(useTimelineModelStore.getState().rowIdsByThreadId[threadId]).toEqual([
      "message:message-row-store",
    ]);
  });

  it("keeps row id references stable for in-place live row updates", async () => {
    vi.useFakeTimers();
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow({
      threadId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      entry: {
        kind: "message",
        id: messageId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        sequence: 1,
      },
      message: {
        id: messageId,
        role: "assistant",
        text: "Hel",
        turnId,
        streaming: true,
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(16);
    const rowIdsAfterFirstPatch = useTimelineModelStore.getState().rowIdsByThreadId[threadId];

    primeLiveTimelineRow({
      threadId,
      updatedAt: "2026-01-01T00:00:03.000Z",
      entry: {
        kind: "message",
        id: messageId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        sequence: 1,
      },
      message: {
        id: messageId,
        role: "assistant",
        text: "Hello",
        turnId,
        streaming: true,
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(16);

    expect(useTimelineModelStore.getState().rowIdsByThreadId[threadId]).toBe(rowIdsAfterFirstPatch);
    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "Hello",
    ]);
  });

  it("publishes mixed live row bursts once per frame", async () => {
    vi.useFakeTimers();
    const { primeLiveTimelineRow, removeLiveTimelineRow } = await import("./timelineModelStore");
    const firstActivityId = EventId.makeUnsafe("activity-frame-burst-one");
    const secondActivityId = EventId.makeUnsafe("activity-frame-burst-two");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 1,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "Previous",
          turnId,
          streaming: true,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
      { flush: "sync" },
    );

    let publishCount = 0;
    const unsubscribe = useTimelineModelStore.subscribe(() => {
      publishCount += 1;
    });

    removeLiveTimelineRow({
      threadId,
      kind: "message",
      id: String(messageId),
    });
    for (const [index, activityId] of [firstActivityId, secondActivityId].entries()) {
      primeLiveTimelineRow({
        threadId,
        updatedAt: `2026-01-01T00:00:0${String(index + 3)}.000Z`,
        entry: {
          kind: "activity",
          id: activityId,
          createdAt: `2026-01-01T00:00:0${String(index + 3)}.000Z`,
          turnId,
          sequence: index + 2,
        },
        activity: {
          id: activityId,
          kind: "tool.completed",
          tone: "tool",
          summary: `Ran command ${String(index + 1)}`,
          payload: { itemType: "command_execution", command: `echo ${String(index + 1)}` },
          turnId,
          sequence: index + 2,
          createdAt: `2026-01-01T00:00:0${String(index + 3)}.000Z`,
        },
      });
    }

    expect(publishCount).toBe(0);
    await vi.advanceTimersByTimeAsync(16);

    unsubscribe();
    expect(publishCount).toBe(1);
    expect(readTimelineRowsProjection(threadId).messages).toEqual([]);
    expect(readTimelineRowsProjection(threadId).activities.map((activity) => activity.id)).toEqual([
      firstActivityId,
      secondActivityId,
    ]);
  });

  it("applies concurrent live row bursts with one revision bump per thread", async () => {
    vi.useFakeTimers();
    const { primeLiveTimelineRow } = await import("./timelineModelStore");
    let publishCount = 0;
    const unsubscribe = useTimelineModelStore.subscribe(() => {
      publishCount += 1;
    });

    primeLiveTimelineRow({
      threadId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      entry: {
        kind: "message",
        id: messageId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        sequence: 1,
      },
      message: {
        id: messageId,
        role: "assistant",
        text: "First agent",
        turnId,
        streaming: true,
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
    });
    primeLiveTimelineRow({
      threadId: otherThreadId,
      updatedAt: "2026-01-01T00:00:03.000Z",
      entry: {
        kind: "message",
        id: otherMessageId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        sequence: 1,
      },
      message: {
        id: otherMessageId,
        role: "assistant",
        text: "Second agent",
        turnId,
        streaming: true,
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    });

    await vi.advanceTimersByTimeAsync(16);
    unsubscribe();

    const state = useTimelineModelStore.getState();
    expect(publishCount).toBe(1);
    expect(state.revision).toBe(1);
    expect(state.revisionByThreadId[threadId]).toBe(1);
    expect(state.revisionByThreadId[otherThreadId]).toBe(1);
    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "First agent",
    ]);
    expect(
      readTimelineRowsProjection(otherThreadId).messages.map((message) => message.text),
    ).toEqual(["Second agent"]);
  });

  it("can flush optimistic user rows synchronously", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 1,
        },
        message: {
          id: messageId,
          role: "user",
          text: "Run this now",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
      { flush: "sync" },
    );

    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "Run this now",
    ]);
    expect(useTimelineModelStore.getState().rowIdsByThreadId[threadId]).toEqual([
      "message:message-row-store",
    ]);
  });

  it("preserves source-index order for live rows that arrive out of order", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");
    const activityId = EventId.makeUnsafe("activity-row-store");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:03.000Z",
        entry: {
          kind: "activity",
          id: activityId,
          createdAt: "2026-01-01T00:00:03.000Z",
          turnId,
          sequence: 3,
        },
        activity: {
          id: activityId,
          kind: "tool.completed",
          tone: "tool",
          summary: "Ran command",
          payload: { itemType: "command_execution", command: "bun typecheck" },
          turnId,
          sequence: 3,
          createdAt: "2026-01-01T00:00:03.000Z",
        },
      },
      { flush: "sync" },
    );
    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:02.000Z",
          turnId,
          sequence: 2,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "Streaming",
          turnId,
          streaming: true,
          sequence: 2,
          createdAt: "2026-01-01T00:00:02.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
      { flush: "sync" },
    );

    expect(useTimelineModelStore.getState().rowIdsByThreadId[threadId]).toEqual([
      "message:message-row-store",
      "activity:activity-row-store",
    ]);
    expect(readTimelineRowsProjection(threadId).rows.map((row) => row.id)).toEqual([
      "message:message-row-store",
      "activity:activity-row-store",
    ]);
  });

  it("preserves image previews when a server echo replaces an optimistic user row", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");
    const attachmentId = "attachment-row-store";

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 1,
        },
        message: {
          id: messageId,
          role: "user",
          text: "Attached image",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 123,
              previewUrl: "blob:local-preview",
            },
          ] as unknown as NonNullable<
            OrchestrationReadModel["threads"][number]["messages"][number]["attachments"]
          >,
        },
      },
      { flush: "sync" },
    );
    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:03.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 1,
        },
        message: {
          id: messageId,
          role: "user",
          text: "Attached image",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 123,
            },
          ],
        },
      },
      { flush: "sync" },
    );

    expect(readTimelineRowsProjection(threadId).messages[0]?.attachments?.[0]).toMatchObject({
      id: attachmentId,
      previewUrl: "/attachments/attachment-row-store",
    });
  });

  it("does not let an empty final assistant event erase live assistant text", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 1,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "hi",
          turnId,
          streaming: true,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
      { flush: "sync" },
    );
    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:03.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 1,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
      },
      { flush: "sync" },
    );

    expect(readTimelineRowsProjection(threadId).messages[0]).toMatchObject({
      text: "hi",
      streaming: false,
      updatedAt: "2026-01-01T00:00:03.000Z",
    });
  });

  it("appends streaming assistant deltas for the same live row", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 1,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "Hel",
          turnId,
          streaming: true,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
      { flush: "sync" },
    );
    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:03.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 2,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "lo",
          turnId,
          streaming: true,
          sequence: 2,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
      },
      { flush: "sync" },
    );

    expect(readTimelineRowsProjection(threadId).messages[0]).toMatchObject({
      text: "Hello",
      streaming: true,
    });
  });

  it("does not duplicate cumulative streaming assistant text", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 1,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "Hel",
          turnId,
          streaming: true,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
      { flush: "sync" },
    );
    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:03.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 2,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "Hello",
          turnId,
          streaming: true,
          sequence: 2,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
      },
      { flush: "sync" },
    );

    expect(readTimelineRowsProjection(threadId).messages[0]).toMatchObject({
      text: "Hello",
      streaming: true,
    });
  });

  it("orders same-turn live rows by source sequence", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");
    const activityId = EventId.makeUnsafe("activity-row-store-thinking");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:03.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:03.000Z",
          turnId,
          sequence: 3,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "Answer",
          turnId,
          streaming: false,
          sequence: 3,
          createdAt: "2026-01-01T00:00:03.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
      },
      { flush: "sync" },
    );
    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:04.000Z",
        entry: {
          kind: "activity",
          id: activityId,
          createdAt: "2026-01-01T00:00:04.000Z",
          turnId,
          sequence: 4,
        },
        activity: {
          id: activityId,
          tone: "info",
          kind: "task.progress",
          summary: "Thinking",
          payload: {},
          turnId,
          sequence: 4,
          createdAt: "2026-01-01T00:00:04.000Z",
        },
      },
      { flush: "sync" },
    );

    expect(readTimelineRowsProjection(threadId).rows.map((row) => row.id)).toEqual([
      `message:${messageId}`,
      `activity:${activityId}`,
    ]);
  });

  it("appends live rows after existing metadata-only history", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");
    const secondMessageId = MessageId.makeUnsafe("message-row-store-second");

    useTimelineModelStore.getState().primeMetadata({
      threadId,
      revision: "rev:metadata-only",
      updatedAt: "2026-01-01T00:00:00.000Z",
      totalRows: 10,
      tailStartRowIndex: 0,
    });

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 11,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "First live row",
          turnId,
          streaming: true,
          sequence: 11,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
      { flush: "sync" },
    );
    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:03.000Z",
        entry: {
          kind: "message",
          id: secondMessageId,
          createdAt: "2026-01-01T00:00:02.000Z",
          turnId,
          sequence: 12,
        },
        message: {
          id: secondMessageId,
          role: "assistant",
          text: "Second live row",
          turnId,
          streaming: true,
          sequence: 12,
          createdAt: "2026-01-01T00:00:02.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
      },
      { flush: "sync" },
    );

    const projection = readTimelineRowsProjection(threadId);
    expect(projection.rows.map((row) => row.startSourceIndex)).toEqual([10, 11]);
    expect(useTimelineModelStore.getState().metadataByThreadId[threadId]?.totalRows).toBe(12);
  });

  it("removes rolled back optimistic rows", async () => {
    vi.useFakeTimers();
    const { primeLiveTimelineRow, removeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 1,
        },
        message: {
          id: messageId,
          role: "user",
          text: "Rollback me",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
      { flush: "sync" },
    );

    removeLiveTimelineRow({
      threadId,
      kind: "message",
      id: String(messageId),
    });

    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "Rollback me",
    ]);
    await vi.advanceTimersByTimeAsync(16);

    expect(readTimelineRowsProjection(threadId).messages).toEqual([]);
    expect(useTimelineModelStore.getState().rowIdsByThreadId[threadId]).toEqual([]);
  });

  it("removes multiple live rows with a single revision bump", async () => {
    vi.useFakeTimers();
    const { primeLiveTimelineRow, removeLiveTimelineRows } = await import("./timelineModelStore");
    const firstActivityId = EventId.makeUnsafe("activity-first");
    const secondActivityId = EventId.makeUnsafe("activity-second");

    for (const [index, activityId] of [firstActivityId, secondActivityId].entries()) {
      primeLiveTimelineRow(
        {
          threadId,
          updatedAt: `2026-01-01T00:00:0${String(index + 2)}.000Z`,
          entry: {
            kind: "activity",
            id: activityId,
            createdAt: `2026-01-01T00:00:0${String(index + 1)}.000Z`,
            turnId,
            sequence: index + 1,
          },
          activity: {
            id: activityId,
            kind: "reasoning",
            summary: `Reasoning ${String(index + 1)}`,
            payload: null,
            tone: "info",
            turnId,
            sequence: index + 1,
            createdAt: `2026-01-01T00:00:0${String(index + 1)}.000Z`,
          },
        },
        { flush: "sync" },
      );
    }

    const revisionBeforeRemoval = useTimelineModelStore.getState().revision;
    removeLiveTimelineRows([
      { threadId, kind: "activity", id: String(firstActivityId) },
      { threadId, kind: "activity", id: String(secondActivityId) },
    ]);

    expect(useTimelineModelStore.getState().revision).toBe(revisionBeforeRemoval);
    await vi.advanceTimersByTimeAsync(16);

    expect(readTimelineRowsProjection(threadId).activities).toEqual([]);
    expect(useTimelineModelStore.getState().rowIdsByThreadId[threadId]).toEqual([]);
    expect(useTimelineModelStore.getState().revision).toBe(revisionBeforeRemoval + 1);
  });

  it("does not bump revisions for unchanged row height writes", async () => {
    vi.useFakeTimers();
    const { writeTimelineModelRowHeight } = await import("./timelineModelStore");

    writeTimelineModelRowHeight("row-height-cache-key", 48);
    await vi.advanceTimersByTimeAsync(16);
    const revisionAfterFirstWrite = useTimelineModelStore.getState().revision;
    const rowHeightRevisionAfterFirstWrite = useTimelineModelStore.getState().rowHeightRevision;

    writeTimelineModelRowHeight("row-height-cache-key", 48);
    await vi.advanceTimersByTimeAsync(16);

    expect(useTimelineModelStore.getState().revision).toBe(revisionAfterFirstWrite);
    expect(useTimelineModelStore.getState().rowHeightRevision).toBe(
      rowHeightRevisionAfterFirstWrite,
    );
  });

  it("coalesces row height revision bumps per frame", async () => {
    vi.useFakeTimers();
    const { writeTimelineModelRowHeight } = await import("./timelineModelStore");

    writeTimelineModelRowHeight("row-height-cache-key-one", 48);
    writeTimelineModelRowHeight("row-height-cache-key-two", 72);
    writeTimelineModelRowHeight("row-height-cache-key-three", 96);

    expect(useTimelineModelStore.getState().rowHeightRevision).toBe(0);
    await vi.advanceTimersByTimeAsync(16);

    expect(useTimelineModelStore.getState().rowHeightRevision).toBe(1);
  });

  it("projects bounded placeholder windows for large unloaded timelines", () => {
    useTimelineModelStore.getState().primeMetadata({
      threadId,
      revision: "rev:1m",
      updatedAt: "2026-01-01T00:00:00.000Z",
      totalRows: 1_000_000,
      tailStartRowIndex: 999_900,
    });

    const windowProjection = readTimelineRowsWindowProjection({
      threadId,
      startRowIndex: 500_000,
      endRowIndexExclusive: 500_050,
    });

    expect(windowProjection.totalRows).toBe(1_000_000);
    expect(windowProjection.slots).toHaveLength(50);
    expect(windowProjection.slots.every((slot) => slot.kind === "placeholder")).toBe(true);
  });

  it("hydrates all thread timeline rows from the thread source model and reuses them", async () => {
    nativeApiMock.getThread.mockResolvedValue({
      id: threadId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      messages: [
        {
          id: MessageId.makeUnsafe("user-row-store"),
          role: "user",
          text: "Hi",
          turnId,
          streaming: false,
          sequence: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: messageId,
          role: "assistant",
          text: "Hello",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      activities: [],
      proposedPlans: [],
    });

    await fetchThreadTimelineRowsHydration(threadId);
    await fetchThreadTimelineRowsHydration(threadId);

    expect(nativeApiMock.getThread).toHaveBeenCalledTimes(1);
    expect(isThreadTimelineRowsFullyHydrated(threadId)).toBe(true);
    expect(readTimelineRowsProjection(threadId).rowIds).toEqual([
      "message:user-row-store",
      "message:message-row-store",
    ]);
    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "Hi",
      "Hello",
    ]);
  });

  it("backs off background open prefetch after a hydration timeout", async () => {
    vi.useFakeTimers();
    nativeApiMock.getThread.mockReturnValue(new Promise(() => undefined));

    const firstPrefetch = startThreadTimelineRowsOpenPrefetch({
      threadId,
      priority: "background",
    });

    await vi.advanceTimersByTimeAsync(10_751);
    await firstPrefetch.done;

    expect(nativeApiMock.getThread).toHaveBeenCalledTimes(1);

    const secondPrefetch = startThreadTimelineRowsOpenPrefetch({
      threadId,
      priority: "background",
    });
    await secondPrefetch.done;
    await vi.advanceTimersByTimeAsync(10_751);

    expect(nativeApiMock.getThread).toHaveBeenCalledTimes(1);
  });

  it("notifies the thread read-model observer with the fetched thread", async () => {
    const fetchedThread = {
      id: threadId,
      updatedAt: "2026-01-01T00:00:03.000Z",
      messages: [],
      activities: [],
      proposedPlans: [],
    };
    nativeApiMock.getThread.mockResolvedValue(fetchedThread);
    const observer = vi.fn();
    setThreadReadModelObserver(observer);

    await fetchThreadTimelineRowsHydration(threadId);

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith(fetchedThread);
  });

  it("promotes an in-flight background open prefetch to fire immediately", async () => {
    vi.useFakeTimers();
    nativeApiMock.getThread.mockResolvedValue({
      id: threadId,
      updatedAt: "2026-01-01T00:00:03.000Z",
      messages: [],
      activities: [],
      proposedPlans: [],
    });

    const backgroundPrefetch = startThreadTimelineRowsOpenPrefetch({
      threadId,
      priority: "background",
    });

    // The background prefetch is still parked in its startup delay; nothing has
    // fetched yet.
    await vi.advanceTimersByTimeAsync(16);
    expect(nativeApiMock.getThread).not.toHaveBeenCalled();

    // An immediate open (e.g. the user clicks the thread) must not wait out the
    // remaining background delay.
    const immediatePrefetch = startThreadTimelineRowsOpenPrefetch({
      threadId,
      priority: "immediate",
    });
    await vi.advanceTimersByTimeAsync(16);
    expect(nativeApiMock.getThread).toHaveBeenCalledTimes(1);

    await immediatePrefetch.done;
    await backgroundPrefetch.done;
    expect(nativeApiMock.getThread).toHaveBeenCalledTimes(1);
  });

  it("refetches timeline rows when a fully populated cache is from an old model version", async () => {
    useTimelineModelStore.getState().primeSnapshot({
      threadId,
      revision: "rev:old-cache",
      updatedAt: "2026-01-01T00:00:02.000Z",
      totalRows: 1,
      rows: [
        {
          id: "message:message-row-store",
          kind: "message",
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
          contentVersion: "snapshot:old",
          startSourceIndex: 0,
          endSourceIndexExclusive: 1,
          turnId,
          sourceRefs: [
            {
              kind: "message",
              id: "message-row-store",
              createdAt: "2026-01-01T00:00:01.000Z",
              sourceIndex: 0,
              turnId,
              sequence: 1,
            },
          ],
        },
      ],
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Old cached answer",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      activities: [],
      proposedPlans: [],
    });
    useTimelineModelStore.setState((state) => ({
      ...state,
      completeSnapshotByThreadId: {
        ...state.completeSnapshotByThreadId,
        [threadId]: {
          revision: "rev:old-cache",
          totalRows: 1,
          loadedAt: Date.now(),
        },
      },
      metadataByThreadId: {
        ...state.metadataByThreadId,
        [threadId]: {
          threadId,
          revision: "rev:old-cache",
          updatedAt: "2026-01-01T00:00:02.000Z",
          totalRows: 1,
          tailStartRowIndex: 0,
        },
      },
    }));
    nativeApiMock.getThread.mockResolvedValue({
      id: threadId,
      updatedAt: "2026-01-01T00:00:03.000Z",
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Fresh backend answer",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      activities: [],
      proposedPlans: [],
    });

    expect(isThreadTimelineRowsFullyHydrated(threadId)).toBe(false);
    const hydration = await fetchThreadTimelineRowsHydration(threadId);

    expect(nativeApiMock.getThread).toHaveBeenCalledTimes(1);
    expect(hydration.revision).toBe(`${threadId}:2026-01-01T00:00:03.000Z:1`);
    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "Fresh backend answer",
    ]);
  });

  it("reuses timeline rows projections until row or source entities change", () => {
    useTimelineModelStore.getState().primeSnapshot({
      threadId,
      revision: "rev:cached-projection",
      updatedAt: "2026-01-01T00:00:02.000Z",
      totalRows: 1,
      rows: [
        {
          id: "message:message-row-store",
          kind: "message",
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
          contentVersion: "snapshot:1",
          startSourceIndex: 0,
          endSourceIndexExclusive: 1,
          turnId,
          sourceRefs: [
            {
              kind: "message",
              id: "message-row-store",
              createdAt: "2026-01-01T00:00:01.000Z",
              sourceIndex: 0,
              turnId,
              sequence: 1,
            },
          ],
        },
      ],
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Loaded",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      activities: [],
      proposedPlans: [],
    });

    const firstProjection = readTimelineRowsProjection(threadId);
    const secondProjection = readTimelineRowsProjection(threadId);
    expect(secondProjection).toBe(firstProjection);

    useTimelineModelStore.getState().primeSnapshot({
      threadId: otherThreadId,
      revision: "rev:other-thread",
      updatedAt: "2026-01-01T00:00:04.000Z",
      totalRows: 1,
      rows: [
        {
          id: "message:message-row-store-other",
          kind: "message",
          createdAt: "2026-01-01T00:00:04.000Z",
          updatedAt: "2026-01-01T00:00:04.000Z",
          contentVersion: "other:1",
          startSourceIndex: 0,
          endSourceIndexExclusive: 1,
          turnId,
          sourceRefs: [
            {
              kind: "message",
              id: "message-row-store-other",
              createdAt: "2026-01-01T00:00:04.000Z",
              sourceIndex: 0,
              turnId,
              sequence: 1,
            },
          ],
        },
      ],
      messages: [
        {
          id: otherMessageId,
          role: "assistant",
          text: "Other loaded",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:04.000Z",
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
      ],
      activities: [],
      proposedPlans: [],
    });

    const afterUnrelatedThreadHydration = readTimelineRowsProjection(threadId);
    expect(afterUnrelatedThreadHydration).toBe(firstProjection);

    useTimelineModelStore.getState().patchRow(threadId, {
      id: "message:message-row-store",
      kind: "message",
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
      contentVersion: "snapshot:2",
      startSourceIndex: 0,
      endSourceIndexExclusive: 1,
      turnId,
      sourceRefs: [
        {
          kind: "message",
          id: "message-row-store",
          createdAt: "2026-01-01T00:00:01.000Z",
          sourceIndex: 0,
          turnId,
          sequence: 1,
        },
      ],
    });

    const changedProjection = readTimelineRowsProjection(threadId);
    expect(changedProjection).not.toBe(firstProjection);
    expect(changedProjection.rows[0]?.contentVersion).toBe("snapshot:2");
  });

  it("recovers replayed live rows without duplicating hydrated source rows", async () => {
    vi.useFakeTimers();
    useTimelineModelStore.getState().primeSnapshot({
      threadId,
      revision: "rev:replay",
      updatedAt: "2026-01-01T00:00:02.000Z",
      totalRows: 1,
      rows: [
        {
          id: "message:message-row-store",
          kind: "message",
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
          contentVersion: "snapshot:1",
          startSourceIndex: 0,
          endSourceIndexExclusive: 1,
          turnId,
          sourceRefs: [
            {
              kind: "message",
              id: "message-row-store",
              createdAt: "2026-01-01T00:00:01.000Z",
              sourceIndex: 0,
              turnId,
              sequence: 1,
            },
          ],
        },
      ],
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Loaded",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      activities: [],
      proposedPlans: [],
    });

    const { primeLiveTimelineRow } = await import("./timelineModelStore");
    primeLiveTimelineRow({
      threadId,
      updatedAt: "2026-01-01T00:00:03.000Z",
      entry: {
        kind: "message",
        id: messageId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        sequence: 1,
      },
      message: {
        id: messageId,
        role: "assistant",
        text: "Recovered",
        turnId,
        streaming: false,
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(16);

    expect(useTimelineModelStore.getState().rowIdsByThreadId[threadId]).toEqual([
      "message:message-row-store",
    ]);
    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "Recovered",
    ]);
  });

  it("does not shrink live assistant text when a shorter final update arrives", async () => {
    vi.useFakeTimers();
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow({
      threadId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      entry: {
        kind: "message",
        id: messageId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        sequence: 2,
      },
      message: {
        id: messageId,
        role: "assistant",
        text: "I checked contracts and adapters.",
        turnId,
        streaming: true,
        sequence: 2,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(16);

    primeLiveTimelineRow({
      threadId,
      updatedAt: "2026-01-01T00:00:03.000Z",
      entry: {
        kind: "message",
        id: messageId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        sequence: 3,
      },
      message: {
        id: messageId,
        role: "assistant",
        text: "I checked",
        turnId,
        streaming: false,
        sequence: 3,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(16);

    expect(readTimelineRowsProjection(threadId).messages[0]).toMatchObject({
      text: "I checked contracts and adapters.",
      streaming: false,
    });
  });

  it("keeps live streaming rows authoritative when a stale snapshot arrives mid-turn", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    // Live streamed assistant content is ahead of the server projection.
    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:05.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 2,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "I checked contracts and adapters.",
          turnId,
          streaming: true,
          sequence: 2,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      },
      { flush: "sync" },
    );

    const stateBeforeSnapshot = useTimelineModelStore.getState();

    // A lagging read-model snapshot arrives while the turn is still streaming.
    // With preferExistingLiveRows the snapshot must not clobber live rows.
    primeThreadTimelineRowsMetadataFromReadModelThread(
      {
        id: threadId,
        updatedAt: "2026-01-01T00:00:02.000Z",
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "I checked",
            turnId,
            streaming: false,
            sequence: 2,
            createdAt: "2026-01-01T00:00:01.000Z",
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
        ],
        activities: [],
        proposedPlans: [],
      } as unknown as OrchestrationReadModel["threads"][number],
      { preferExistingLiveRows: true },
    );

    expect(useTimelineModelStore.getState()).toBe(stateBeforeSnapshot);
    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "I checked contracts and adapters.",
    ]);
  });

  it("reconciles a snapshot when the thread is not actively streaming", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:05.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 2,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "I checked contracts and adapters.",
          turnId,
          streaming: true,
          sequence: 2,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      },
      { flush: "sync" },
    );

    const stateBeforeSnapshot = useTimelineModelStore.getState();

    // Without the live-rows preference (turn settled), the snapshot reconciles.
    primeThreadTimelineRowsMetadataFromReadModelThread({
      id: threadId,
      updatedAt: "2026-01-01T00:00:06.000Z",
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "I checked contracts and adapters.",
          turnId,
          streaming: false,
          sequence: 2,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:06.000Z",
        },
      ],
      activities: [],
      proposedPlans: [],
    } as unknown as OrchestrationReadModel["threads"][number]);

    expect(useTimelineModelStore.getState()).not.toBe(stateBeforeSnapshot);
    expect(readTimelineRowsProjection(threadId).messages[0]).toMatchObject({
      text: "I checked contracts and adapters.",
      streaming: false,
    });
  });

  it("skips snapshot reconciliation for streaming threads in the batch path", async () => {
    const { primeLiveTimelineRow } = await import("./timelineModelStore");

    primeLiveTimelineRow(
      {
        threadId,
        updatedAt: "2026-01-01T00:00:05.000Z",
        entry: {
          kind: "message",
          id: messageId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId,
          sequence: 2,
        },
        message: {
          id: messageId,
          role: "assistant",
          text: "Streaming answer in progress",
          turnId,
          streaming: true,
          sequence: 2,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      },
      { flush: "sync" },
    );

    const stateBeforeSnapshot = useTimelineModelStore.getState();

    primeThreadTimelineRowsMetadataFromReadModelThreads(
      [
        {
          id: threadId,
          updatedAt: "2026-01-01T00:00:02.000Z",
          messages: [
            {
              id: messageId,
              role: "assistant",
              text: "Streaming",
              turnId,
              streaming: false,
              sequence: 2,
              createdAt: "2026-01-01T00:00:01.000Z",
              updatedAt: "2026-01-01T00:00:02.000Z",
            },
          ],
          activities: [],
          proposedPlans: [],
        } as unknown as OrchestrationReadModel["threads"][number],
      ],
      { preferExistingLiveRowsThreadIds: new Set([threadId]) },
    );

    expect(useTimelineModelStore.getState()).toBe(stateBeforeSnapshot);
    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "Streaming answer in progress",
    ]);
  });
});
