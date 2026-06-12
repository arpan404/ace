import { MessageId, type OrchestrationProposedPlanId } from "@ace/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TurnId } from "@ace/contracts";

vi.mock("../ChatMarkdown", () => ({
  default: ({
    isStreaming,
    renderPlainText,
    text,
  }: {
    isStreaming?: boolean;
    renderPlainText?: boolean;
    text?: string;
  }) => (
    <div
      data-chat-markdown-is-streaming={String(Boolean(isStreaming))}
      data-chat-markdown-render-plain-text={String(Boolean(renderPlainText))}
    >
      {text}
    </div>
  ),
}));

vi.mock("./MessageCopyButton", () => ({
  MessageCopyButton: ({
    text,
    size,
    variant,
  }: {
    text: string;
    size?: string;
    variant?: string;
  }) => (
    <button
      type="button"
      aria-label="Copy message"
      {...(size === "icon-xs" ? { "data-copy-text": text } : {})}
      data-size={size}
      data-variant={variant}
    />
  ),
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

const makeTimelineVirtualItem = (index: number) =>
  ({
    end: (index + 1) * 100,
    index,
    key: index,
    lane: 0,
    size: 100,
    start: index * 100,
  }) as const;

describe("MessagesTimeline", { timeout: 30_000 }, () => {
  it("derives timeline snapshot prefetch direction from scroll speed", async () => {
    const { deriveTimelineScrollPrefetchRequest } = await import("./MessagesTimeline");

    expect(
      deriveTimelineScrollPrefetchRequest({
        currentScrollTop: 30,
        previousScrollTop: 0,
        elapsedMs: 100,
      }),
    ).toMatchObject({ direction: "both", lookaheadRows: 32 });
    expect(
      deriveTimelineScrollPrefetchRequest({
        currentScrollTop: 500,
        previousScrollTop: 0,
        elapsedMs: 100,
      }),
    ).toMatchObject({
      direction: "newer",
      lookaheadRows: 256,
    });
    expect(
      deriveTimelineScrollPrefetchRequest({
        currentScrollTop: 0,
        previousScrollTop: 1_200,
        elapsedMs: 100,
      }),
    ).toMatchObject({
      direction: "older",
      lookaheadRows: 1_024,
    });
  });

  it("derives rendered window state from loaded rows only", async () => {
    const { deriveTimelineRenderedWindowState } = await import("./MessagesTimeline");

    expect(
      deriveTimelineRenderedWindowState({
        renderedVirtualItems: [
          makeTimelineVirtualItem(2),
          makeTimelineVirtualItem(3),
          makeTimelineVirtualItem(4),
        ],
        virtualizedRows: [
          { id: "loaded-0", kind: "message" },
          { id: "loaded-1", kind: "message" },
          { id: "loaded-2", kind: "message" },
          { id: "loaded-3", kind: "message" },
          { id: "loaded-4", kind: "message" },
        ] as unknown as Parameters<typeof deriveTimelineRenderedWindowState>[0]["virtualizedRows"],
      }),
    ).toMatchObject({
      loadedEndIndexExclusive: 5,
      loadedRowCount: 5,
      loadedStartIndex: 2,
      overscanLoadedEndIndexExclusive: 5,
      overscanLoadedStartIndex: 2,
    });
  });

  it("maps rendered row windows back to global timeline indexes", async () => {
    const { deriveGlobalTimelineRenderedWindowState, deriveTimelineRenderedWindowState } =
      await import("./MessagesTimeline");
    const rows = [
      {
        id: "entry-5000",
        kind: "message",
      },
      {
        id: "completed-work-summary:entry-5001",
        kind: "completed-work-summary",
        sourceEntryIds: ["entry-5001", "entry-5002"],
        detailRows: [],
        visibleDiagnosticRows: [],
      },
      {
        id: "entry-5003",
        kind: "message",
      },
    ] as unknown as Parameters<typeof deriveGlobalTimelineRenderedWindowState>[0]["rows"];
    const renderedWindowState = deriveTimelineRenderedWindowState({
      renderedVirtualItems: [makeTimelineVirtualItem(1), makeTimelineVirtualItem(2)],
      virtualizedRows: rows,
    });

    expect(
      deriveGlobalTimelineRenderedWindowState({
        renderedWindowState,
        rows,
        timelineIndexByEntryId: new Map([
          ["entry-5000", 5_000],
          ["entry-5001", 5_001],
          ["entry-5002", 5_002],
          ["entry-5003", 5_003],
        ]),
      }),
    ).toMatchObject({
      loadedEndIndexExclusive: 5_004,
      loadedStartIndex: 5_001,
      overscanLoadedEndIndexExclusive: 5_004,
      overscanLoadedStartIndex: 5_001,
    });
  });

  it("returns null when no loaded rows are rendered", async () => {
    const { deriveTimelineRenderedWindowState } = await import("./MessagesTimeline");

    expect(
      deriveTimelineRenderedWindowState({
        renderedVirtualItems: [],
        virtualizedRows: [],
      }),
    ).toBeNull();
  });

  it("derives a rendered window for underfilled unvirtualized timelines", async () => {
    const { deriveTimelineRenderedWindowState } = await import("./MessagesTimeline");

    expect(
      deriveTimelineRenderedWindowState({
        renderedVirtualItems: [],
        totalRowCount: 2,
        virtualizedRows: [],
      }),
    ).toEqual({
      loadedEndIndexExclusive: 2,
      loadedRowCount: 2,
      loadedStartIndex: 0,
      overscanLoadedEndIndexExclusive: 2,
      overscanLoadedStartIndex: 0,
    });
  });

  it("keeps active thread rows visible while rows are temporarily empty", async () => {
    const { resolveVisibleTimelineRows } = await import("./useTimelineRowsController");
    const retainedRows = [
      {
        id: "previous-user-row",
        kind: "message",
      },
    ] as unknown as ReturnType<typeof resolveVisibleTimelineRows>["rows"];

    const result = resolveVisibleTimelineRows({
      activeThreadId: "thread-1",
      retainedRows: {
        activeThreadId: "thread-1",
        rows: retainedRows,
      },
      syncRows: [],
    });

    expect(result.loading).toBe(false);
    expect(result.rows).toBe(retainedRows);
  });

  it("can opt out of retaining previous rows", async () => {
    const { resolveVisibleTimelineRows } = await import("./useTimelineRowsController");
    const retainedRows = [
      {
        id: "previous-user-row",
        kind: "message",
      },
    ] as unknown as ReturnType<typeof resolveVisibleTimelineRows>["rows"];

    const result = resolveVisibleTimelineRows({
      activeThreadId: "thread-1",
      retainedRows: {
        activeThreadId: "thread-1",
        rows: retainedRows,
      },
      retainRowsWhileLoading: false,
      syncRows: [],
    });

    expect(result.loading).toBe(false);
    expect(result.rows).toEqual([]);
  });

  it("keeps active thread rows visible while snapshot hydration catches up", async () => {
    const { resolveVisibleTimelineRows } = await import("./useTimelineRowsController");
    const retainedRows = [
      {
        id: "previous-user-row",
        kind: "message",
      },
    ] as unknown as ReturnType<typeof resolveVisibleTimelineRows>["rows"];

    const result = resolveVisibleTimelineRows({
      activeThreadId: "thread-1",
      loading: true,
      retainedRows: {
        activeThreadId: "thread-1",
        rows: retainedRows,
      },
      syncRows: [],
    });

    expect(result.loading).toBe(false);
    expect(result.rows).toBe(retainedRows);
  });

  it("shows loading while an empty thread snapshot is in flight", async () => {
    const { resolveVisibleTimelineRows } = await import("./useTimelineRowsController");

    const result = resolveVisibleTimelineRows({
      activeThreadId: "thread-1",
      loading: true,
      retainedRows: null,
      syncRows: [],
    });

    expect(result.loading).toBe(true);
    expect(result.rows).toEqual([]);
  });

  it("uses sync rows before retained rows", async () => {
    const { resolveVisibleTimelineRows } = await import("./useTimelineRowsController");
    const syncRows = [
      {
        id: "sync-row",
        kind: "message",
      },
    ] as unknown as ReturnType<typeof resolveVisibleTimelineRows>["rows"];

    const result = resolveVisibleTimelineRows({
      activeThreadId: "thread-1",
      retainedRows: {
        activeThreadId: "thread-2",
        rows: [],
      },
      syncRows,
    });

    expect(result.loading).toBe(false);
    expect(result.rows).toBe(syncRows);
  });

  it("can prefer retained rows over sync rows during native row rebuilds", async () => {
    const { resolveVisibleTimelineRows } = await import("./useTimelineRowsController");
    const retainedRows = [
      {
        id: "retained-native-row",
        kind: "message",
      },
    ] as unknown as ReturnType<typeof resolveVisibleTimelineRows>["rows"];
    const syncRows = [
      {
        id: "fallback-legacy-row",
        kind: "message",
      },
    ] as unknown as ReturnType<typeof resolveVisibleTimelineRows>["rows"];

    const result = resolveVisibleTimelineRows({
      activeThreadId: "thread-1",
      loading: true,
      preferRetainedRows: true,
      retainedRows: {
        activeThreadId: "thread-1",
        rows: retainedRows,
      },
      syncRows,
    });

    expect(result.loading).toBe(false);
    expect(result.rows).toBe(retainedRows);
  });

  it("does not show the async loading skeleton on cache misses or history restore", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousWorker = globalThis.Worker;
    vi.stubGlobal("document", {
      ...previousDocument,
      createElement: () => ({}),
    });
    vi.stubGlobal("window", {
      ...previousWindow,
      localStorage: globalThis.localStorage,
    });
    vi.stubGlobal(
      "Worker",
      class MockWorker {
        terminate(): void {}
      } as unknown as typeof Worker,
    );
    try {
      const timelineEntries = Array.from({ length: 80 }, (_, index) => {
        const createdAt = `2026-03-17T19:${String(12 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
        return {
          id: `metadata-user-${index + 1}`,
          kind: "message" as const,
          createdAt,
          message: {
            id: MessageId.makeUnsafe(`metadata-user-${index + 1}`),
            role: "user" as const,
            text: `Metadata row ${index + 1}`,
            createdAt,
            streaming: false,
          },
        };
      });
      const baseProps = {
        hasMessages: true,
        isWorking: false,
        activeTurnInProgress: false,
        activeTurnStartedAt: null,
        getScrollContainer: () => null,
        timelineEntries,
        completionDividerBeforeEntryId: null,
        completionSummary: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        expandedWorkGroups: {},
        onToggleWorkGroup: () => {},
        onOpenTurnDiff: () => {},
        revertTurnCountByUserMessageId: new Map(),
        onRevertUserMessage: () => {},
        isRevertingCheckpoint: false,
        onImageExpand: () => {},
        markdownCwd: undefined,
        resolvedTheme: "light" as const,
        timestampFormat: "locale" as const,
        workspaceRoot: undefined,
      };

      const cacheMissMarkup = renderToStaticMarkup(<MessagesTimeline {...baseProps} />);

      expect(cacheMissMarkup).not.toContain("Loading conversation");
    } finally {
      vi.stubGlobal("document", previousDocument);
      vi.stubGlobal("window", previousWindow);
      vi.stubGlobal("Worker", previousWorker);
    }
  });

  it("shows deferred assistant markdown as readable plain text instead of skeleton bars", async () => {
    const { AssistantMarkdownDeferredPreview } = await import("./MessagesTimeline");

    const markup = renderToStaticMarkup(
      <AssistantMarkdownDeferredPreview text="**Deferred markdown 20**" />,
    );

    expect(markup).toContain('data-assistant-markdown-deferred-preview="true"');
    expect(markup).toContain("**Deferred markdown 20**");
    expect(markup).not.toContain("data-assistant-markdown-pending");
  });

  it("does not render fake message skeletons while timeline rows are loading", async () => {
    const { TimelineRowsLoadingFallback } = await import("./MessagesTimeline");

    const markup = renderToStaticMarkup(<TimelineRowsLoadingFallback />);

    expect(markup).toContain("Loading thread...");
    expect(markup).not.toContain("animate-pulse");
    expect(markup).not.toContain("rounded-full bg-muted");
  });

  it("does not show thread fetching chrome over already rendered rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "loaded-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("loaded-user"),
              role: "user",
              text: "Already loaded",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Already loaded");
    expect(markup).not.toContain("Loading thread...");
    expect(markup).not.toContain('data-thread-timeline-fetching="true"');
    expect(markup).not.toContain("Loading conversation");
  });

  it("renders terminal assistant output through markdown instead of forcing plain text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "user-markdown",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("user-markdown"),
              role: "user",
              text: "Return markdown",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-markdown",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-markdown"),
              role: "assistant",
              text: "**Done**\n\n```text\nhello\n```",
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:35.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-chat-markdown-render-plain-text="false"');
    expect(markup).toContain("**Done**");
  });

  it("keeps reasoning work as plain timeline text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "reasoning-markdown",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "reasoning-markdown",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Reasoning",
              detail: "**thinking** about ```text```",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:reasoning-markdown": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("**thinking** about ```text```");
    expect(markup).not.toContain("<strong>thinking</strong>");
    expect(markup).not.toContain("data-chat-markdown-render-plain-text");
  });

  it("falls back to a small unvirtualized tail once work is no longer actively running", async () => {
    const { deriveFirstUnvirtualizedTimelineRowIndex } = await import("./MessagesTimeline");
    const rows = [
      {
        kind: "message" as const,
        id: "user-1",
        createdAt: "2026-03-17T19:12:20.000Z",
        message: {
          id: MessageId.makeUnsafe("user-1"),
          role: "user" as const,
          text: "Start",
          createdAt: "2026-03-17T19:12:20.000Z",
          streaming: false,
        },
        durationStart: "2026-03-17T19:12:20.000Z",
        completionSummary: null,
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        kind: "work" as const,
        id: `thinking-${index}`,
        createdAt: `2026-03-17T19:12:${21 + index}.000Z`,
        workEntry: {
          id: `thinking-entry-${index}`,
          createdAt: `2026-03-17T19:12:${21 + index}.000Z`,
          label: "Reasoning",
          detail: `step ${index}`,
          tone: "thinking" as const,
        },
      })),
    ];

    expect(
      deriveFirstUnvirtualizedTimelineRowIndex(rows, {
        activeTurnInProgress: true,
        activeTurnStartedAt: "2026-03-17T19:12:21.000Z",
        preserveCurrentTurnTail: false,
      }),
    ).toBe(rows.length - 8);
  });

  it("schedules deferred assistant markdown from newest to oldest", async () => {
    const { derivePendingAssistantMarkdownMessageIdsBottomUp } = await import("./MessagesTimeline");
    const rows = Array.from({ length: 5 }, (_, index) => ({
      kind: "message" as const,
      id: `assistant-${index + 1}`,
      createdAt: `2026-03-17T19:12:${20 + index}.000Z`,
      message: {
        id: MessageId.makeUnsafe(`assistant-${index + 1}`),
        role: "assistant" as const,
        text: `Assistant ${index + 1}`,
        createdAt: `2026-03-17T19:12:${20 + index}.000Z`,
        streaming: false,
      },
      durationStart: `2026-03-17T19:12:${20 + index}.000Z`,
      completionSummary: null,
    }));

    expect(
      derivePendingAssistantMarkdownMessageIdsBottomUp(rows, {
        firstUnvirtualizedRowIndex: rows.length,
        immediateMessageIds: new Set(["assistant-5"]),
        mountedMessageIds: new Set(["assistant-4"]),
        renderedMessageIds: new Set(["assistant-2"]),
      }),
    ).toEqual(["assistant-3", "assistant-1"]);
  });

  it("keeps the current turn tail expanded only while work is actively running", async () => {
    const { deriveFirstUnvirtualizedTimelineRowIndex } = await import("./MessagesTimeline");
    const rows = [
      {
        kind: "message" as const,
        id: "user-1",
        createdAt: "2026-03-17T19:12:20.000Z",
        message: {
          id: MessageId.makeUnsafe("user-1"),
          role: "user" as const,
          text: "Start",
          createdAt: "2026-03-17T19:12:20.000Z",
          streaming: false,
        },
        durationStart: "2026-03-17T19:12:20.000Z",
        completionSummary: null,
      },
      {
        kind: "message" as const,
        id: "assistant-1",
        createdAt: "2026-03-17T19:12:20.500Z",
        message: {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant" as const,
          text: "Working on it",
          createdAt: "2026-03-17T19:12:20.500Z",
          streaming: false,
        },
        durationStart: "2026-03-17T19:12:20.500Z",
        completionSummary: null,
      },
      {
        kind: "message" as const,
        id: "user-2",
        createdAt: "2026-03-17T19:12:21.000Z",
        message: {
          id: MessageId.makeUnsafe("user-2"),
          role: "user" as const,
          text: "Continue",
          createdAt: "2026-03-17T19:12:21.000Z",
          streaming: false,
        },
        durationStart: "2026-03-17T19:12:21.000Z",
        completionSummary: null,
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        kind: "work" as const,
        id: `tool-${index}`,
        createdAt: `2026-03-17T19:12:${22 + index}.000Z`,
        workEntry: {
          id: `tool-entry-${index}`,
          createdAt: `2026-03-17T19:12:${22 + index}.000Z`,
          label: "Run command",
          detail: `cmd ${index}`,
          tone: "tool" as const,
        },
      })),
      {
        kind: "working" as const,
        id: "working-indicator-row",
        createdAt: "2026-03-17T19:12:40.000Z",
        mode: "live" as const,
        activity: "default" as const,
        goalStartedAt: null,
        intentText: null,
      },
    ];

    expect(
      deriveFirstUnvirtualizedTimelineRowIndex(rows, {
        activeTurnInProgress: true,
        activeTurnStartedAt: "2026-03-17T19:12:21.000Z",
        preserveCurrentTurnTail: true,
      }),
    ).toBe(2);
  });

  it("keeps historical rows virtualized while the active turn is in progress", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const timelineEntries = Array.from({ length: 24 }, (_, index) => ({
      id: `entry-${index + 1}`,
      kind: "message" as const,
      createdAt: `2026-03-17T19:12:${20 + index}.000Z`,
      message: {
        id: MessageId.makeUnsafe(`message-${index + 1}`),
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `Message ${index + 1}`,
        createdAt: `2026-03-17T19:12:${20 + index}.000Z`,
        streaming: false,
      },
    }));

    const activeTurnMarkup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:31.000Z"
        getScrollContainer={() => ({}) as unknown as HTMLDivElement}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const idleTurnMarkup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => ({}) as unknown as HTMLDivElement}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:command-card": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(activeTurnMarkup).toContain('data-virtualizer-buffer="true"');
    expect(idleTurnMarkup).toContain('data-virtualizer-buffer="true"');
  });

  it("renders the virtualized buffer whenever historical rows exist", async () => {
    const { shouldRenderTimelineVirtualizedBuffer } = await import("./MessagesTimeline");

    expect(
      shouldRenderTimelineVirtualizedBuffer({
        virtualizedRowCount: 24,
      }),
    ).toBe(true);
    expect(
      shouldRenderTimelineVirtualizedBuffer({
        virtualizedRowCount: 0,
      }),
    ).toBe(false);
  });

  it("derives a concrete fallback virtual range when the virtualizer has not mounted items yet", async () => {
    const { deriveFallbackTimelineVirtualItems } = await import("./MessagesTimeline");

    const items = deriveFallbackTimelineVirtualItems({
      rowCount: 100,
      estimateSize: () => 50,
      getItemKey: (index) => `row-${index}`,
      overscan: 2,
      scrollTop: 2_250,
      viewportHeight: 500,
    });

    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.index).toBeLessThanOrEqual(43);
    expect(items.at(-1)?.index).toBeGreaterThanOrEqual(55);
    expect(items.every((item) => item.start >= 0 && item.end > item.start)).toBe(true);
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:31.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("tabler-icon-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
    expect(markup).toContain('data-user-message-bubble="true"');
    expect(markup).toContain("glass-inset");
    expect(markup).toContain("rounded-2xl");
    expect(markup).not.toContain("translate-y-[38%] rotate-45");
    expect(markup).not.toContain('data-thread-row="true"');
  });

  it("highlights provider command tokens in user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "entry-provider-command",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-provider-command"),
              role: "user",
              text: "$frontend-design polish this\n@browser-use inspect it",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        providerCommands={[
          { name: "frontend-design", kind: "skill", promptPrefix: "$frontend-design" },
          { name: "browser-use", kind: "plugin", promptPrefix: "@browser-use" },
        ]}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Frontend Design");
    expect(markup).toContain("Browser Use");
    expect(markup).toContain("bg-muted/40");
    expect(markup).toContain("tabler-icon-stack-2");
    expect(markup).toContain("lucide-plug");
  });

  it("highlights Codex goal command tokens in user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "entry-goal-command",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-goal-command"),
              role: "user",
              text: "/goal hhh",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        providerCommands={[{ name: "goal", kind: "provider" }]}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Goal");
    expect(markup).toContain("hhh");
    expect(markup).toContain("bg-emerald-500/12");
    expect(markup).toContain("lucide-target");
  });

  it("does not highlight Codex goal command tokens in the middle of user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "entry-mid-goal-command",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-mid-goal-command"),
              role: "user",
              text: "jjhj /goal",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        providerCommands={[{ name: "goal", kind: "provider" }]}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("jjhj");
    expect(markup).toContain("/goal");
    expect(markup).not.toContain("lucide-target");
    expect(markup).not.toContain("bg-emerald-500/12");
  });

  it("renders at-prefixed file mentions as mention chips", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "entry-file-mention",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-file-mention"),
              role: "user",
              text: "@src/checkpointing/Services directory",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Services");
    expect(markup).toContain("directory");
    expect(markup).not.toContain("@src/checkpointing/Services");
    expect(markup).not.toContain("tabler-icon-stack-2");
    expect(markup).toContain("bg-muted/35");
    expect(markup).toContain("<img");
  });

  it("hides design request ids while still showing captured images", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const designPrompt = [
      "Increase spacing around this card title",
      "",
      "<browser_design_context>",
      JSON.stringify(
        {
          requestId: "DR-4A9D2B6E",
          pageUrl: "https://example.com/dashboard",
          pagePath: "/dashboard",
          selection: { x: 24, y: 18, width: 360, height: 210 },
          targetElement: null,
          mainContainer: null,
        },
        null,
        2,
      ),
      "</browser_design_context>",
    ].join("\n");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "entry-design-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("msg-design-1"),
              role: "user",
              text: designPrompt,
              attachments: [
                {
                  type: "image",
                  id: "attachment-design-1",
                  name: "design-capture.png",
                  mimeType: "image/png",
                  sizeBytes: 1200,
                  previewUrl: "https://example.com/design-capture.png",
                },
              ],
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain("DR-4A9D2B6E");
    expect(markup).toContain("design-capture.png");
    expect(markup).toContain("<img");
  });

  it("renders assistant image attachments as assistant output", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-image-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant:image:1024x1536:attachment-generated-1"),
              role: "assistant",
              text: "",
              attachments: [
                {
                  type: "image",
                  id: "attachment-generated-1",
                  name: "generated-image.png",
                  mimeType: "image/png",
                  sizeBytes: 1200,
                  previewUrl: "https://example.com/generated-image.png",
                },
              ],
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("generated-image.png");
    expect(markup).toContain("<img");
    expect(markup).toContain("aspect-ratio:1024 / 1536");
    expect(markup).toContain("max-width:min(100%, 42rem)");
    expect(markup).toContain("width:28vh");
    expect(markup).not.toContain("(empty response)");
  });

  it("renders assistant image generation placeholders without markdown or tool rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-image-placeholder-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant:image:1536x1024:image-1"),
              role: "assistant",
              text: "",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-image-generation-placeholder="true"');
    expect(markup).toContain("image-generation-placeholder-surface");
    expect(markup).toContain("image-generation-placeholder-sheen");
    expect(markup).toContain("aspect-ratio:1536 / 1024");
    expect(markup).toContain("width:81vh");
    expect(markup).not.toContain("image-generation-progress-track");
    expect(markup).not.toContain("1 tool call");
    expect(markup).not.toContain("(empty response)");
    expect(markup).not.toContain("data-chat-markdown");
  });

  it("does not infer image generation placeholders from command or assistant text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        getScrollContainer={() => null}
        liveTimers={false}
        timelineEntries={[
          {
            id: "user-imagegen-command",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("user-imagegen-command"),
              role: "user",
              text: "$imagegen create a 1024x1024 app mockup",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-imagegen-status",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-imagegen-status"),
              role: "assistant",
              text: "Using imagegen to create the mockup.",
              createdAt: "2026-03-17T19:12:32.000Z",
              streaming: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-image-generation-placeholder="true"');
    expect(markup).not.toContain("Generating image");
    expect(markup).toContain("Working for");
  });

  it("does not infer image generation placeholders from generic tool detail text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        getScrollContainer={() => null}
        liveTimers={false}
        timelineEntries={[
          {
            id: "user-generic-tool-image-request",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("user-generic-tool-image-request"),
              role: "user",
              text: "generate mobile version in portrait",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "work-generic-tool",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-generic-tool",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Tool call",
              detail: "generate image at 1024x1536",
              tone: "tool",
              toolTitle: "Tool call",
              itemType: "dynamic_tool_call",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-image-generation-placeholder="true"');
    expect(markup).toContain('data-work-entry-id="work-generic-tool"');
    expect(markup).toContain("Working for");
  });

  it("does not infer image generation placeholders from tool names or dimensions", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        getScrollContainer={() => null}
        liveTimers={false}
        timelineEntries={[
          {
            id: "user-imagegen-backend-tool",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("user-imagegen-backend-tool"),
              role: "user",
              text: "generate mobile version in portrait",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "work-imagegen-tool",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-imagegen-tool",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Tool call",
              detail: "1024x1536",
              tone: "tool",
              toolTitle: "image_gen",
              itemType: "dynamic_tool_call",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-image-generation-placeholder="true"');
    expect(markup).not.toContain("aspect-ratio:1024 / 1536");
    expect(markup).toContain('data-work-entry-id="work-imagegen-tool"');
    expect(markup).toContain("Working for");
  });

  it("uses custom restore copy for the revert action tooltip", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const messageId = MessageId.makeUnsafe("user-rebuildable-provider");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "user-rebuildable-provider",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: messageId,
              role: "user",
              text: "Restore me",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map([[messageId, 1]])}
        onRevertUserMessage={() => {}}
        revertActionTitle="Restore files and rebuild from this message"
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Restore files and rebuild from this message");
  });

  it("renders context compaction entries as normal work rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:31.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:image-view-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain('data-work-entry-id="work-1"');
  });

  it("renders assistant, tool, follow-up, thinking, and tool rows in chronological order", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-1"),
              role: "assistant",
              text: "I inspected the workspace.",
              turnId: TurnId.makeUnsafe("turn-1"),
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
          {
            id: "work-tool-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.500Z",
            entry: {
              id: "work-tool-1",
              createdAt: "2026-03-17T19:12:29.500Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "src/session-logic.ts",
              tone: "tool",
            },
          },
          {
            id: "assistant-2",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-2"),
              role: "assistant",
              text: "The timeline needed message segmentation.",
              turnId: TurnId.makeUnsafe("turn-1"),
              createdAt: "2026-03-17T19:12:30.000Z",
              completedAt: "2026-03-17T19:12:31.000Z",
              streaming: false,
            },
          },
          {
            id: "thinking-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-1",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "Segment assistant output around tool execution.",
              tone: "thinking",
            },
          },
          {
            id: "work-tool-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-tool-2",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Apply patch",
              toolTitle: "Apply patch",
              detail: "apps/web/src/components/chat/MessagesTimeline.tsx",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{
          "work-group:work-tool-1": true,
          "work-group:thinking-1": true,
          "work-group:work-tool-2": true,
        }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const firstAssistantIndex = markup.indexOf("I inspected the workspace.");
    const firstToolIndex = markup.indexOf("Read session-logic.ts");
    const followUpIndex = markup.indexOf("The timeline needed message segmentation.");
    const thinkingIndex = markup.indexOf("Segment assistant output around tool execution.");
    const secondToolIndex = markup.indexOf("apps/web/src/components/chat/MessagesTimeline.tsx");

    expect(firstAssistantIndex).toBeGreaterThanOrEqual(0);
    expect(firstToolIndex).toBeGreaterThan(firstAssistantIndex);
    expect(followUpIndex).toBeGreaterThan(firstToolIndex);
    expect(thinkingIndex).toBeGreaterThan(followUpIndex);
    expect(secondToolIndex).toBeGreaterThan(thinkingIndex);
    expect(markup).toContain('data-work-entry-tone="thinking"');
    expect(markup).toContain('data-work-entry-id="work-tool-1"');
    expect(markup).toContain('data-work-entry-id="work-tool-2"');
    expect(markup).not.toContain('data-thread-row="true"');
  });

  it("skips blank assistant placeholder rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-empty",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-empty"),
              role: "assistant",
              text: "  \n",
              turnId: TurnId.makeUnsafe("turn-empty"),
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:28.500Z",
              streaming: false,
            },
          },
          {
            id: "tool-after-empty",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "tool-after-empty",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "README.md",
              tone: "tool",
            },
          },
          {
            id: "assistant-visible",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-visible"),
              role: "assistant",
              text: "Here is the actual response.",
              turnId: TurnId.makeUnsafe("turn-empty"),
              createdAt: "2026-03-17T19:12:30.000Z",
              completedAt: "2026-03-17T19:12:31.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:tool-after-empty": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-message-id="assistant-empty"');
    expect(markup).toContain("README.md");
    expect(markup).toContain("Here is the actual response.");
  });

  it("prefers human-readable detail over noisy wrapper commands in tool rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:31.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "work-tool-noisy-command",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-tool-noisy-command",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Running format & checks",
              toolTitle: "Running format & checks",
              detail: "Running format & checks",
              command:
                "cat package.json || true\nnode -e \"const p=require('./package.json')\"\nbun fmt && bun lint && bun typecheck",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Running format &amp; checks");
    expect(markup).not.toContain("cat package.json");
  });

  it("renders command work entries as shell cards with status and output", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "command-card",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "command-card",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Ran command bun run check",
              toolTitle: "Run command",
              command: "bun run check",
              terminalOutput: "Format issues found in above 1 files.",
              status: "failed",
              exitCode: 1,
              durationMs: 191,
              itemType: "command_execution",
              requestKind: "command",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:command-card": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Ran bun run check");
    expect(markup).toContain('data-work-entry-kind="command"');
    expect(markup).toContain('data-work-entry-nested="true"');
    expect(markup).toContain('data-command-output-disclosure="true"');
    expect(markup).toContain('data-command-output-open="false"');
    expect(markup).toContain("text-[12px]");
    expect(markup).toContain("tabler-icon-terminal");
    expect(markup).toContain("size-3.5");
    expect(markup).toContain("bun run check");
    expect(markup).not.toContain('data-command-output-panel="true"');
    expect(markup).not.toContain("Format issues found");
  });

  it("collapses completed tool-only runs until expanded", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    type ToolFixtureEntry = {
      label: string;
      toolTitle: string;
      itemType?: "file_change";
      changedFiles?: string[];
    };
    const hiddenEntries: ToolFixtureEntry[] = [
      {
        label: "Read file",
        toolTitle: "Read file",
        itemType: "file_change" as const,
        changedFiles: ["README.md"],
      },
      {
        label: "Open file",
        toolTitle: "Open file",
        itemType: "file_change" as const,
        changedFiles: ["package.json"],
      },
      { label: "Apply patch", toolTitle: "Apply patch" },
      { label: "Run command", toolTitle: "Run command" },
    ];
    const visibleEntries: ToolFixtureEntry[] = Array.from({ length: 6 }, (_, index) => ({
      label: `Tool ${index + 5}`,
      toolTitle: `Tool ${index + 5}`,
    }));
    const timelineEntries = [...hiddenEntries, ...visibleEntries].map((entry, index) => {
      const workEntry: {
        id: string;
        createdAt: string;
        label: string;
        toolTitle: string;
        detail: string;
        tone: "tool";
        itemType?: "file_change";
        changedFiles?: string[];
      } = {
        id: `work-tool-${index + 1}`,
        createdAt: `2026-03-17T19:12:${String(20 + index).padStart(2, "0")}.000Z`,
        label: entry.label,
        toolTitle: entry.toolTitle,
        detail: `detail ${index + 1}`,
        tone: "tool",
      };
      if (entry.itemType) {
        workEntry.itemType = entry.itemType;
      }
      if (entry.changedFiles) {
        workEntry.changedFiles = entry.changedFiles;
      }
      return {
        id: `work-tool-${index + 1}`,
        kind: "work" as const,
        createdAt: `2026-03-17T19:12:${String(20 + index).padStart(2, "0")}.000Z`,
        entry: workEntry,
      };
    });

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:image-view-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-tool-disclosure="true"');
    expect(markup).toContain('data-tool-disclosure-open="false"');
    expect(markup).toContain('data-meta-disclosure="true"');
    expect(markup).toContain('data-meta-disclosure-elapsed="9s"');
    expect(markup).toContain("Ran 1 command");
    expect(markup).toContain("Read 2 files");
    expect(markup).toContain("Edited 1 file");
    expect(markup).toContain("Used 6 tools");
    expect(markup).not.toContain("rounded-xl border border-border/45 bg-background/70");
    expect(markup).not.toContain('data-work-entry-id="work-tool-1"');
    expect(markup).not.toContain('data-work-entry-id="work-tool-10"');
  });

  it("keeps the current live work row visible while earlier live work can expand", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const timelineEntries = Array.from({ length: 10 }, (_, index) => ({
      id: `live-work-tool-${index + 1}`,
      kind: "work" as const,
      createdAt: `2026-03-17T19:12:${String(20 + index).padStart(2, "0")}.000Z`,
      entry: {
        id: `live-work-tool-${index + 1}`,
        createdAt: `2026-03-17T19:12:${String(20 + index).padStart(2, "0")}.000Z`,
        label: `Live Tool ${index + 1}`,
        toolTitle: `Live Tool ${index + 1}`,
        detail: `live detail ${index + 1}`,
        tone: "tool" as const,
      },
    }));

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:20.000Z"
        getScrollContainer={() => null}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:live-work-tool-1": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-tool-disclosure="true"');
    expect(markup).toContain('data-tool-disclosure-open="true"');
    expect(markup).toContain("Used 9 tools");
    expect(markup).not.toContain('data-meta-disclosure-elapsed="');
    expect(markup).toContain('data-work-entry-id="live-work-tool-1"');
    expect(markup).toContain('data-work-entry-id="live-work-tool-10"');
  });

  it("keeps completed tool rows before the active turn alongside live rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:35.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "old-tool-before-turn",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "old-tool-before-turn",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "README.md",
              tone: "tool",
            },
          },
          {
            id: "new-tool-during-turn",
            kind: "work",
            createdAt: "2026-03-17T19:12:36.000Z",
            entry: {
              id: "new-tool-during-turn",
              createdAt: "2026-03-17T19:12:36.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun lint",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Read 1 file");
    expect(markup).not.toContain("README.md");
    expect(markup).toContain("bun lint");
    expect(markup.indexOf("Read 1 file")).toBeLessThan(markup.indexOf("bun lint"));
  });

  it("summarizes mixed tool groups by activity type", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "read-config",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "read-config",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Read config",
              tone: "tool",
              requestKind: "file-read",
            },
          },
          {
            id: "run-tests",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "run-tests",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run tests",
              command: "bun run test",
              tone: "tool",
              requestKind: "command",
            },
          },
          {
            id: "search-code",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "search-code",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Find",
              tone: "tool",
              itemType: "dynamic_tool_call",
            },
          },
          {
            id: "patch-files",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "patch-files",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Edit files",
              changedFiles: ["src/a.ts", "src/b.ts"],
              tone: "tool",
              requestKind: "file-change",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Ran 1 command");
    expect(markup).toContain("Read 1 file");
    expect(markup).toContain("Edited 2 files");
    expect(markup).toContain("Searched once");
    expect(markup).not.toContain("Edited 2 files, explored 1 file, 1 search, ran 1 command");
    expect(markup).not.toContain("ran 1 command");
    expect(markup).not.toContain("searched 1 search");
    expect(markup).not.toContain("4 tool calls");
  });

  it("shows accumulated thinking text instead of a single truncated token line", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "thinking-accumulated",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-accumulated",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail:
                "Inspecting package.json and lockfiles to determine available scripts before patching the renderer.",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:thinking-accumulated": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(
      "Inspecting package.json and lockfiles to determine available scripts before patching the renderer.",
    );
    expect(markup).not.toContain("line-clamp-4");
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("text-[11px] leading-5 text-foreground/76");
    expect(markup).not.toContain("font-mono text-[10px] leading-4 text-muted-foreground/65");
  });

  it("keeps thinking disclosures collapsed by default until expanded", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "thinking-collapsed",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-collapsed",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "Inspecting package scripts before patching the renderer.",
              durationMs: 650,
              tone: "thinking",
            },
          },
          {
            id: "thinking-collapsed-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.500Z",
            entry: {
              id: "thinking-collapsed-2",
              createdAt: "2026-03-17T19:12:33.500Z",
              label: "Reasoning",
              detail: "Comparing the grouped timeline behavior after the patch.",
              durationMs: 850,
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:image-view-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-thinking-disclosure="true"');
    expect(markup).toContain('data-thinking-disclosure-open="false"');
    expect(markup).toContain('data-meta-disclosure-elapsed="2s"');
    expect(markup).toContain("Thinking x2");
    expect(markup).toContain("1.5s");
    expect(markup).not.toContain("Thought 2 times for 2 seconds");
    expect(markup).not.toContain("Thought for 2s");
    expect(markup).not.toContain('data-work-entry-id="thinking-collapsed"');
    expect(markup).not.toContain('data-work-entry-id="thinking-collapsed-2"');
    expect(markup).not.toContain("Inspecting package scripts before patching the renderer.");
    expect(markup).not.toContain("Comparing the grouped timeline behavior after the patch.");
  });

  it("summarizes completed thinking without fabricating thinking duration", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "thinking-next-event-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.100Z",
            entry: {
              id: "thinking-next-event-1",
              createdAt: "2026-03-17T19:12:31.100Z",
              label: "Reasoning",
              detail: "Checking the existing render boundary.",
              tone: "thinking",
            },
          },
          {
            id: "thinking-next-event-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.600Z",
            entry: {
              id: "thinking-next-event-2",
              createdAt: "2026-03-17T19:12:31.600Z",
              label: "Reasoning",
              detail: "Preparing the grouped summary after the reasoning block.",
              tone: "thinking",
            },
          },
          {
            id: "tool-after-thinking",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.400Z",
            entry: {
              id: "tool-after-thinking",
              createdAt: "2026-03-17T19:12:33.400Z",
              label: "Read file",
              detail: "Opening the patched timeline component.",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-meta-disclosure-elapsed="3s"');
    expect(markup).not.toContain('data-meta-disclosure-elapsed="1s"');
  });

  it("hides grouped elapsed metadata while the current turn is still running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "thinking-live-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.100Z",
            entry: {
              id: "thinking-live-1",
              createdAt: "2026-03-17T19:12:31.100Z",
              label: "Reasoning",
              detail: "Checking the existing render boundary.",
              tone: "thinking",
            },
          },
          {
            id: "thinking-live-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.600Z",
            entry: {
              id: "thinking-live-2",
              createdAt: "2026-03-17T19:12:31.600Z",
              label: "Reasoning",
              detail: "Preparing the grouped summary after the reasoning block.",
              tone: "thinking",
            },
          },
          {
            id: "tool-after-live-thinking",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.400Z",
            entry: {
              id: "tool-after-live-thinking",
              createdAt: "2026-03-17T19:12:33.400Z",
              label: "Read file",
              detail: "Opening the patched timeline component.",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-meta-disclosure-elapsed="');
  });

  it("moves completed thinking behind a disclosure once assistant output starts", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "thinking-live",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "thinking-live",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Reasoning",
              detail: "Inspecting the package scripts before composing the response.",
              tone: "thinking",
            },
          },
          {
            id: "assistant-streaming",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-streaming"),
              role: "assistant",
              text: "Running checks now.",
              turnId: TurnId.makeUnsafe("turn-live"),
              createdAt: "2026-03-17T19:12:32.000Z",
              streaming: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const thinkingIndex = markup.indexOf('data-thinking-disclosure="true"');
    const assistantIndex = markup.indexOf('data-message-id="assistant-streaming"');

    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(thinkingIndex);
    expect(markup).not.toContain('data-work-entry-id="thinking-live"');
  });

  it("renders thinking rows inside the thread log without the old card treatment", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "thinking-outline",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-outline",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "Tracing the ordering boundary before patching the renderer.",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:thinking-outline": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-meta-disclosure="true"');
    expect(markup).not.toContain("bg-amber-500/[0.035]");
    expect(markup).not.toContain("rounded-xl border border-border/45 bg-background/70");
    expect(markup).toContain('data-thinking-disclosure="true"');
    expect(markup).toContain('data-meta-disclosure-body="true"');
    expect(markup).toContain('data-work-entry-tone="thinking"');
    expect(markup).toContain('data-work-entry-nested="true"');
    expect(markup).toContain("lucide-brain");
    expect(markup).toContain("size-3.5");
    expect(markup).toContain("text-foreground/76");
    expect(markup).toContain("Tracing the ordering boundary before patching the renderer.");
    expect(markup).toContain('data-meta-disclosure-elapsed="1s"');
    expect(markup).toContain(">Thinking<");
    expect(markup).not.toContain("Thought 1 time for 1 second");
  });

  it("keeps assistant follow-ups beneath the preceding work row in order", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:31.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "work-tool-followup",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-tool-followup",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "apps/web/src/session-logic.ts",
              tone: "tool",
            },
          },
          {
            id: "assistant-followup",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-followup"),
              role: "assistant",
              text: "Found the next grouping edge case.",
              turnId: TurnId.makeUnsafe("turn-followup"),
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:33.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const workIndex = markup.indexOf('data-tool-disclosure="true"');
    const assistantIndex = markup.indexOf('data-message-id="assistant-followup"');

    expect(workIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(workIndex);
    expect(markup).toContain("Found the next grouping edge case.");
    expect(markup).not.toContain('data-work-entry-id="work-tool-followup"');
  });

  it("keeps changed-files summaries visible after a newer user message", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("assistant-with-diff");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "tool-before-diff",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-before-diff",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun lint",
              tone: "tool",
            },
          },
          {
            id: "assistant-with-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the timeline rendering.",
              turnId: TurnId.makeUnsafe("turn-diff"),
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:33.000Z",
              streaming: false,
            },
          },
          {
            id: "user-after-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:34.000Z",
            message: {
              id: MessageId.makeUnsafe("user-after-diff"),
              role: "user",
              text: "Thanks, now fix the spacing below it.",
              createdAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-diff"),
                completedAt: "2026-03-17T19:12:33.500Z",
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                    additions: 10,
                    deletions: 2,
                  },
                  {
                    path: "apps/web/src/components/chat/ChangedFilesTree.tsx",
                    additions: 4,
                    deletions: 1,
                  },
                ],
              },
            ],
          ])
        }
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-turn-diff-summary="true"');
    expect(markup).toContain("Changed files (2)");
    expect(markup.indexOf("Updated the timeline rendering.")).toBeLessThan(
      markup.indexOf("Changed files (2)"),
    );
    expect(markup.indexOf("Changed files (2)")).toBeLessThan(
      markup.indexOf("Thanks, now fix the spacing below it."),
    );
  });

  it("renders changed-files summaries at the end of the latest assistant turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("assistant-with-diff-latest");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "tool-before-diff-latest",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-before-diff-latest",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun lint",
              tone: "tool",
            },
          },
          {
            id: "assistant-with-diff-latest",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the timeline rendering.",
              turnId: TurnId.makeUnsafe("turn-diff-latest"),
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:33.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId="assistant-with-diff-latest"
        completionSummary="Worked for 2m"
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-diff-latest"),
                completedAt: "2026-03-17T19:12:33.500Z",
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                    additions: 10,
                    deletions: 2,
                  },
                  {
                    path: "apps/web/src/components/chat/ChangedFilesTree.tsx",
                    additions: 4,
                    deletions: 1,
                  },
                ],
              },
            ],
          ])
        }
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-turn-diff-summary="true"');
    expect(markup).toContain("Changed files (2)");
    expect(markup).toContain("Expand all");
    expect(markup).not.toContain("Collapse all");
    expect(markup).toContain('aria-label="Copy message"');
    expect(markup.indexOf("bun lint")).toBeLessThan(
      markup.indexOf("Updated the timeline rendering."),
    );
    expect(markup.indexOf("Updated the timeline rendering.")).toBeLessThan(
      markup.indexOf("Changed files (2)"),
    );
    expect(markup.indexOf('data-response-summary="true"')).toBeLessThan(
      markup.indexOf("Changed files (2)"),
    );
  });

  it("hides raw proposed-plan markers and renders the plan as a timeline panel", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-plan-marker",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-plan-marker"),
              role: "assistant",
              text: "<!--ACE_PROPOSED_PLAN",
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:33.000Z",
              streaming: false,
            },
          },
          {
            id: "plan-rendering",
            kind: "proposed-plan",
            createdAt: "2026-03-17T19:12:33.000Z",
            proposedPlan: {
              id: "plan-rendering" as OrchestrationProposedPlanId,
              createdAt: "2026-03-17T19:12:33.000Z",
              updatedAt: "2026-03-17T19:12:33.000Z",
              turnId: null,
              planMarkdown:
                "<!--ACE_PROPOSED_PLAN_START\n>#Proposed Plan\n\n1.Define SLOs.\n2.Add observability.\n<!--ACE_PROPOSED_PLAN_END",
              implementedAt: null,
              implementationThreadId: null,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-proposed-plan-thread="true"');
    expect(markup).toContain("Proposed Plan");
    expect(markup).toContain("1. Define SLOs.");
    expect(markup).not.toContain("ACE_PROPOSED_PLAN");
    expect(markup).not.toContain('data-message-id="assistant-plan-marker"');
  });

  it("shows compact changed-files actions with assistant revert when available", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("assistant-with-revertable-diff");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-with-revertable-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the files.",
              turnId: TurnId.makeUnsafe("turn-revertable-diff"),
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:33.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-revertable-diff"),
                completedAt: "2026-03-17T19:12:33.500Z",
                checkpointTurnCount: 2,
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                    additions: 10,
                    deletions: 2,
                  },
                ],
              },
            ],
          ])
        }
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        revertTurnCountByAssistantMessageId={new Map([[assistantMessageId, 1]])}
        onRevertAssistantMessage={() => {}}
        revertActionTitle="Revert changes"
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('aria-label="Revert changes"');
    expect(markup).not.toContain(">Revert</button>");
    expect(markup).toContain("View diff");
    expect(markup).toContain('aria-label="Expand all"');
    expect(markup).not.toContain("<span>Collapse all</span>");
  });

  it("hides the changed-files expand action when there are no directories", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("assistant-with-flat-diff");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-with-flat-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the files.",
              turnId: TurnId.makeUnsafe("turn-flat-diff"),
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:33.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-flat-diff"),
                completedAt: "2026-03-17T19:12:33.500Z",
                checkpointTurnCount: 2,
                files: [
                  {
                    path: "README.md",
                    additions: 1,
                    deletions: 0,
                  },
                ],
              },
            ],
          ])
        }
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("View diff");
    expect(markup).not.toContain('aria-label="Expand all"');
    expect(markup).not.toContain('aria-label="Collapse all"');
  });

  it("hides changed-files summaries while the latest turn is still active", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("assistant-with-active-diff");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "tool-before-active-diff",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-before-active-diff",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun run test",
              tone: "tool",
            },
          },
          {
            id: "assistant-with-active-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "I am still verifying this change.",
              turnId: TurnId.makeUnsafe("turn-active-diff"),
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:33.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-active-diff"),
                completedAt: "2026-03-17T19:12:33.500Z",
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                    additions: 10,
                    deletions: 2,
                  },
                ],
              },
            ],
          ])
        }
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Working");
    expect(markup).not.toContain('data-turn-diff-summary="true"');
    expect(markup).not.toContain("Changed files (1)");
  });

  it("shows completed intent and tool activity after completion", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "intent-1",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Running format and checks",
          },
          {
            id: "tool-after-intent",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-after-intent",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun fmt && bun lint",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Running format and checks");
    expect(markup).toContain("bun fmt &amp;&amp; bun lint");
    expect(markup).toContain('data-work-entry-id="tool-after-intent"');
    expect(markup.indexOf("Running format and checks")).toBeLessThan(
      markup.indexOf("bun fmt &amp;&amp; bun lint"),
    );
  });

  it("shows a compact worked-for pill when completed work details are hidden", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        hideCompletedWorkMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "user-for-hidden-work",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("user-for-hidden-work"),
              role: "user",
              text: "Check the file",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "hidden-tool",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "hidden-tool",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "README.md",
              tone: "tool",
            },
          },
          {
            id: "assistant-final",
            kind: "message",
            createdAt: "2026-03-17T19:12:34.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-final"),
              role: "assistant",
              text: "Done.",
              createdAt: "2026-03-17T19:12:34.000Z",
              completedAt: "2026-03-17T19:12:35.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-completed-work-summary="true"');
    expect(markup).toContain('aria-label="Show hidden work logs"');
    expect(markup).toContain("Worked for 4s");
    expect(markup).not.toContain("Read 1 file");
    expect(markup).not.toContain("1 tool call");
    expect(markup).not.toContain("README.md");
  });

  it("collapses non-terminal assistant progress messages without turn ids when completed work is hidden", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        hideCompletedWorkMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "user-legacy-progress",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("user-legacy-progress"),
              role: "user",
              text: "Do the thing.",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-legacy-progress-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-legacy-progress-1"),
              role: "assistant",
              text: "I am inspecting the repo.",
              createdAt: "2026-03-17T19:12:31.000Z",
              completedAt: "2026-03-17T19:12:32.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-legacy-progress-2",
            kind: "message",
            createdAt: "2026-03-17T19:12:33.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-legacy-progress-2"),
              role: "assistant",
              text: "I am running the checks.",
              createdAt: "2026-03-17T19:12:33.000Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-legacy-final",
            kind: "message",
            createdAt: "2026-03-17T19:12:35.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-legacy-final"),
              role: "assistant",
              text: "Done.",
              createdAt: "2026-03-17T19:12:35.000Z",
              completedAt: "2026-03-17T19:12:36.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-completed-work-summary="true"');
    expect(markup).toContain('data-completed-work-summary-hidden-messages="2"');
    expect(markup).not.toContain("I am inspecting the repo.");
    expect(markup).not.toContain("I am running the checks.");
    expect(markup).toContain("Done.");
    expect(markup.match(/data-response-summary="true"/g) ?? []).toHaveLength(1);
  });

  it("does not render completed work summaries that have no expandable details", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[]}
        timelineRowsOverride={[
          {
            id: "user-before-empty-work-summary",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("user-before-empty-work-summary"),
              role: "user",
              text: "Hey",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
            durationStart: "2026-03-17T19:12:30.000Z",
            completionSummary: null,
          },
          {
            id: "completed-work-summary:empty",
            kind: "completed-work-summary",
            createdAt: "2026-03-17T19:12:31.000Z",
            startedAt: "2026-03-17T19:12:31.000Z",
            endedAt: "2026-03-17T19:12:39.000Z",
            sourceEntryIds: [],
            detailRows: [],
            visibleDiagnosticRows: [],
            visibleDiagnosticCacheKey: "empty",
            hiddenMessageCount: 0,
            hiddenThinkingCount: 0,
            toolCallCount: 0,
          },
          {
            id: "assistant-after-empty-work-summary",
            kind: "message",
            createdAt: "2026-03-17T19:12:39.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-after-empty-work-summary"),
              role: "assistant",
              text: "Hi-ready when you are.",
              createdAt: "2026-03-17T19:12:39.000Z",
              completedAt: "2026-03-17T19:12:39.000Z",
              streaming: false,
            },
            durationStart: "2026-03-17T19:12:31.000Z",
            completionSummary: null,
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-completed-work-summary="true"');
    expect(markup).not.toContain("Worked for 8s");
    expect(markup).toContain("Hi-ready when you are.");
  });

  it("omits runtime errors from completed work diagnostics", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        hideCompletedWorkMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "user-before-error",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("user-before-error"),
              role: "user",
              text: "Check the file",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "hidden-tool-before-error",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "hidden-tool-before-error",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "README.md",
              tone: "tool",
            },
          },
          {
            id: "runtime-error-hidden-work",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "runtime-error-hidden-work",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Runtime error",
              detail: "You've hit your rate limit. Please wait for your limit to reset.",
              tone: "error",
              diagnosticKind: "runtime-error",
            },
          },
          {
            id: "runtime-warning-hidden-work",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "runtime-warning-hidden-work",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Runtime warning",
              detail: "Retry scheduled",
              tone: "info",
              diagnosticKind: "runtime-warning",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-completed-work-summary="true"');
    expect(markup).toContain('data-completed-work-visible-diagnostics="true"');
    expect(markup).not.toContain('data-work-entry-id="runtime-error-hidden-work"');
    expect(markup).toContain('data-work-entry-id="runtime-warning-hidden-work"');
    expect(markup).not.toContain("Runtime error");
    expect(markup).toContain("Runtime warning");
    expect(markup).not.toContain("You&#x27;ve hit your rate limit");
    expect(markup).not.toContain("Retry scheduled");
    expect(markup).not.toContain("README.md");
  });

  it("shows completed image-view tool calls", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "intent-image-view",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Reviewing screenshot",
          },
          {
            id: "image-view-tool",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "image-view-tool",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "View image",
              toolTitle: "View image",
              detail: "screenshot.png",
              tone: "tool",
              itemType: "image_view",
              intentText: "Reviewing screenshot",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:image-view-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Reviewing screenshot");
    expect(markup).toContain("screenshot.png");
    expect(markup).toContain('data-work-entry-id="image-view-tool"');
  });

  it("groups completed intent and thinking work into the same disclosure", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "intent-counting-files",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Counting files",
          },
          {
            id: "thinking-after-intent",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "thinking-after-intent",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Reasoning",
              detail: "Checking tracked files before counting everything on disk.",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-meta-disclosure="true"');
    expect(markup).not.toContain('data-intent-disclosure="true"');
    expect(markup).toContain('data-thinking-disclosure="true"');
    expect(markup).toContain("Plan");
    expect(markup).toContain("Thinking");
    expect(markup).toContain('data-meta-disclosure-elapsed="1s"');
    expect(markup).not.toContain("Logged 1 event");
    expect(markup).not.toContain("0 tool calls");
  });

  it("counts info entries as events without double-counting intents", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "intent-refreshing-state",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Refreshing browser state",
          },
          {
            id: "info-context-compacted",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "info-context-compacted",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Plan");
    expect(markup).not.toContain("Logged 1 event");
  });

  it("keeps repeated completed intent bursts with tool calls in chronological order", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "intent-1",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Running format and checks",
          },
          {
            id: "tool-burst-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-burst-1",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun fmt",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
          {
            id: "intent-2",
            kind: "intent",
            createdAt: "2026-03-17T19:12:32.000Z",
            text: "Running format and checks",
          },
          {
            id: "tool-burst-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "tool-burst-2",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun lint",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{
          "work-group:tool-burst-1": true,
          "work-group:tool-burst-2": true,
        }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const firstIntentIndex = markup.indexOf("Running format and checks");
    const firstToolIndex = markup.indexOf("bun fmt");
    const secondIntentIndex = markup.indexOf("Running format and checks", firstIntentIndex + 1);
    const secondToolIndex = markup.indexOf("bun lint");

    expect(firstIntentIndex).toBeGreaterThanOrEqual(0);
    expect(firstToolIndex).toBeGreaterThan(firstIntentIndex);
    expect(secondIntentIndex).toBeGreaterThan(firstToolIndex);
    expect(secondToolIndex).toBeGreaterThan(secondIntentIndex);
    expect(markup.match(/data-intent-message="true"/g) ?? []).toHaveLength(2);
    expect(markup).toContain('data-tool-disclosure-open="true"');
    expect(markup).toContain('data-work-entry-id="tool-burst-1"');
    expect(markup).toContain('data-work-entry-id="tool-burst-2"');
  });

  it("keeps repeated live intent bursts separate while only the current tool stays inline", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "intent-live-1",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Exploring cursor flow",
          },
          {
            id: "tool-live-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-live-1",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "apps/server/src/provider/Layers/ProviderService.ts",
              tone: "tool",
              intentText: "Exploring cursor flow",
            },
          },
          {
            id: "intent-live-2",
            kind: "intent",
            createdAt: "2026-03-17T19:12:32.000Z",
            text: "Exploring cursor flow",
          },
          {
            id: "tool-live-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "tool-live-2",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Search code",
              toolTitle: "Search code",
              detail: "apps/web/src/components/chat/MessagesTimeline.tsx",
              tone: "tool",
              intentText: "Exploring cursor flow",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/data-intent-message="true"/g) ?? []).toHaveLength(0);
    expect(markup.match(/data-inline-intent="true"/g) ?? []).toHaveLength(1);
    expect(markup).toContain('data-tool-disclosure="true"');
    expect(markup).not.toContain("ProviderService.ts");
    expect(markup).toContain("Intent");
    expect(markup).toContain("Exploring cursor flow");
    expect(markup).toContain("MessagesTimeline.tsx");
  });

  it("moves the final response summary into the assistant footer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "user-summary-start",
            kind: "message",
            createdAt: "2026-03-17T19:10:14.000Z",
            message: {
              id: MessageId.makeUnsafe("user-summary-start"),
              role: "user",
              text: "Update the timeline rendering.",
              createdAt: "2026-03-17T19:10:14.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-summary-row",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-summary-message"),
              role: "assistant",
              text: "Updated the timeline rendering.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId="assistant-summary-row"
        completionSummary="Worked for 3s"
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-response-summary="true"');
    expect(markup).toContain('data-response-summary-time="');
    expect(markup).toContain('data-response-summary-elapsed="2m 20s"');
    expect(markup).toContain("opacity-100");
    expect(markup).not.toContain("•");
  });

  it("shows previous assistant time metadata after a later user reply", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-no-meta-row",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-no-meta-message"),
              role: "assistant",
              text: "Updated the timeline rendering.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
          {
            id: "user-after-assistant-no-meta",
            kind: "message",
            createdAt: "2026-03-17T19:12:35.000Z",
            message: {
              id: MessageId.makeUnsafe("user-after-assistant-no-meta"),
              role: "user",
              text: "Follow-up",
              createdAt: "2026-03-17T19:12:35.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-response-summary="true"');
    expect(markup).toContain('data-response-summary-time="');
    expect(markup).toContain('data-response-summary-elapsed="3s"');
    expect(markup).toContain("mt-2 flex min-h-5 flex-wrap");
    expect(markup).not.toContain("opacity-0 group-hover/timeline:opacity-100");
    expect(markup).toContain('data-assistant-turn-copy-action="true"');
    expect(markup).toContain('aria-label="Copy message"');
    expect(markup.indexOf('data-assistant-turn-copy-action="true"')).toBeLessThan(
      markup.indexOf('data-response-summary="true"'),
    );
    expect(markup).not.toContain('aria-label="Fork conversation"');
  });

  it("shows the latest assistant time metadata without hover when no later user reply exists", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-tail-visible",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-tail-visible"),
              role: "assistant",
              text: "Latest assistant response.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-response-summary="true"');
    expect(markup).toContain('data-response-summary-elapsed="3s"');
    expect(markup).not.toContain("opacity-0 group-hover/timeline:opacity-100");
    expect(markup).toContain('data-assistant-turn-copy-action="true"');
    expect(markup).toContain('aria-label="Copy message"');
    expect(markup.indexOf('data-assistant-turn-copy-action="true"')).toBeLessThan(
      markup.indexOf('data-response-summary="true"'),
    );
    expect(markup).not.toContain('aria-label="Fork conversation"');
  });

  it("shows a fork action when the provider supports conversation forking", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-with-fork-action",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-with-fork-action"),
              role: "assistant",
              text: "Latest assistant response.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        onForkConversation={() => {}}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('aria-label="Fork conversation"');
    expect(markup).toContain("Fork conversation");
    expect(markup).toContain("opacity-0 transition-opacity");
    expect(markup).toContain("group-hover/timeline:opacity-100");
    expect(markup.indexOf('aria-label="Copy message"')).toBeLessThan(
      markup.indexOf('data-response-summary="true"'),
    );
    expect(markup.indexOf('data-response-summary="true"')).toBeLessThan(
      markup.indexOf('aria-label="Fork conversation"'),
    );
    expect(markup).toContain('data-variant="ghost"');
  });

  it("hides assistant copy and fork actions while the assistant is working", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("turn-working-actions-hidden");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-working-actions-hidden",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-working-actions-hidden"),
              role: "assistant",
              turnId,
              text: "Partial assistant response.",
              createdAt: "2026-03-17T19:12:31.000Z",
              streaming: true,
            },
          },
          {
            id: "work-after-active-assistant",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-after-active-assistant",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Edit file",
              toolTitle: "Edit file",
              tone: "tool",
              requestKind: "file-change",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        onForkConversation={() => {}}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Partial assistant response.");
    expect(markup).toContain("Edit file");
    expect(markup).not.toContain('data-assistant-turn-copy-action="true"');
    expect(markup).not.toContain('aria-label="Copy message"');
    expect(markup).not.toContain('aria-label="Fork conversation"');
  });

  it("hides assistant footer for completed partial output in the active turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("turn-active-partial-footer-hidden");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "user-active-partial-footer-hidden",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("user-active-partial-footer-hidden"),
              role: "user",
              turnId,
              text: "Audit in deep",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-active-partial-footer-hidden",
            kind: "message",
            createdAt: "2026-03-17T19:12:36.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-active-partial-footer-hidden"),
              role: "assistant",
              turnId,
              text: "Let me do a bottom-up audit, reading every source file.",
              createdAt: "2026-03-17T19:12:36.000Z",
              completedAt: "2026-03-17T19:12:42.000Z",
              streaming: false,
            },
          },
          {
            id: "work-active-after-partial-footer-hidden",
            kind: "work",
            createdAt: "2026-03-17T19:12:43.000Z",
            entry: {
              id: "work-active-after-partial-footer-hidden",
              createdAt: "2026-03-17T19:12:43.000Z",
              label: "Used 2 tools",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        onForkConversation={() => {}}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Let me do a bottom-up audit");
    expect(markup).toContain("Working for");
    expect(markup).not.toContain('data-assistant-turn-footer="true"');
    expect(markup).not.toContain('data-response-summary="true"');
    expect(markup).not.toContain('data-assistant-turn-copy-action="true"');
    expect(markup).not.toContain('aria-label="Fork conversation"');
  });

  it("hides assistant copy and fork actions for completed responses without elapsed timing", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-complete-actions-visible",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-complete-actions-visible"),
              role: "assistant",
              text: "Completed assistant response.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        onForkConversation={() => {}}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Completed assistant response.");
    expect(markup).not.toContain('data-assistant-turn-copy-action="true"');
    expect(markup).not.toContain('aria-label="Copy message"');
    expect(markup).not.toContain('aria-label="Fork conversation"');
  });

  it("does not require a provider slash command to render the fork action", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-with-agnostic-fork-action",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-with-agnostic-fork-action"),
              role: "assistant",
              text: "Latest assistant response.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        providerCommands={[]}
        onForkConversation={() => {}}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('aria-label="Fork conversation"');
  });

  it("shows hover metadata only on the last assistant message within a turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("turn-multi-assistant");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "user-turn-start",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("user-turn-start"),
              role: "user",
              text: "Do the thing.",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-turn-part-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-turn-part-1"),
              role: "assistant",
              turnId,
              text: "First response chunk.",
              createdAt: "2026-03-17T19:12:31.000Z",
              completedAt: "2026-03-17T19:12:32.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-turn-part-2",
            kind: "message",
            createdAt: "2026-03-17T19:12:33.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-turn-part-2"),
              role: "assistant",
              turnId,
              text: "Final response chunk.",
              createdAt: "2026-03-17T19:12:33.000Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/data-response-summary="true"/g) ?? []).toHaveLength(1);
    expect(markup).toContain('data-response-summary-elapsed="4s"');
    expect(markup.match(/data-assistant-turn-copy-action="true"/g) ?? []).toHaveLength(1);
    expect(markup).toContain('data-copy-text="First response chunk.\n\nFinal response chunk."');
  });

  it("copies only the visible terminal assistant message when completed work is hidden", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("turn-hidden-work-copy");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        hideCompletedWorkMessages
        timelineEntries={[
          {
            id: "user-hidden-work-copy",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("user-hidden-work-copy"),
              role: "user",
              text: "Do the thing.",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-hidden-work-copy-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-hidden-work-copy-1"),
              role: "assistant",
              turnId,
              text: "Hidden earlier assistant chunk.",
              createdAt: "2026-03-17T19:12:31.000Z",
              completedAt: "2026-03-17T19:12:32.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-hidden-work-copy-2",
            kind: "message",
            createdAt: "2026-03-17T19:12:33.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-hidden-work-copy-2"),
              role: "assistant",
              turnId,
              text: "Visible final assistant chunk.",
              createdAt: "2026-03-17T19:12:33.000Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain("Hidden earlier assistant chunk.");
    expect(markup).toContain("Visible final assistant chunk.");
    expect(markup).toContain('data-copy-text="Visible final assistant chunk."');
  });

  it("shows fork only on the latest assistant turn while copy remains on each terminal turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const firstTurnId = TurnId.makeUnsafe("turn-copy-fork-first");
    const secondTurnId = TurnId.makeUnsafe("turn-copy-fork-second");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-copy-fork-first",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-copy-fork-first"),
              role: "assistant",
              turnId: firstTurnId,
              text: "First terminal turn.",
              createdAt: "2026-03-17T19:12:31.000Z",
              completedAt: "2026-03-17T19:12:32.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-copy-fork-second",
            kind: "message",
            createdAt: "2026-03-17T19:12:33.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-copy-fork-second"),
              role: "assistant",
              turnId: secondTurnId,
              text: "Second terminal turn.",
              createdAt: "2026-03-17T19:12:33.000Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        onForkConversation={() => {}}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/data-assistant-turn-copy-action="true"/g) ?? []).toHaveLength(2);
    expect(markup.match(/aria-label="Fork conversation"/g) ?? []).toHaveLength(1);
    expect(markup.indexOf("Second terminal turn.")).toBeLessThan(
      markup.indexOf('aria-label="Fork conversation"'),
    );
  });

  it("renders assistant footer before trailing work rows for the turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("turn-footer-after-work");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-before-trailing-work",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-before-trailing-work"),
              role: "assistant",
              turnId,
              text: "Assistant text before work.",
              createdAt: "2026-03-17T19:12:31.000Z",
              completedAt: "2026-03-17T19:12:32.000Z",
              streaming: false,
            },
          },
          {
            id: "work-after-assistant",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "work-after-assistant",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Run command",
              toolTitle: "Run command",
              tone: "tool",
              requestKind: "command",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        onForkConversation={() => {}}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Assistant text before work.");
    expect(markup).toContain("Ran 1 command");
    expect(markup).toContain('data-assistant-turn-footer="true"');
    expect(markup.indexOf("Assistant text before work.")).toBeLessThan(
      markup.indexOf('data-assistant-turn-footer="true"'),
    );
    expect(markup.indexOf('data-assistant-turn-footer="true"')).toBeLessThan(
      markup.indexOf("Ran 1 command"),
    );
    expect(markup.indexOf('data-response-summary="true"')).toBeLessThan(
      markup.indexOf('aria-label="Fork conversation"'),
    );
  });

  it("renders hidden trailing work summary before terminal assistant content", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("turn-footer-after-hidden-work");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        hideCompletedWorkMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "user-before-hidden-trailing-work",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("user-before-hidden-trailing-work"),
              role: "user",
              text: "Do the thing.",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-before-hidden-trailing-work",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-before-hidden-trailing-work"),
              role: "assistant",
              turnId,
              text: "Assistant text before hidden work.",
              createdAt: "2026-03-17T19:12:31.000Z",
              completedAt: "2026-03-17T19:12:32.000Z",
              streaming: false,
            },
          },
          {
            id: "hidden-work-after-assistant",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "hidden-work-after-assistant",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Run command",
              toolTitle: "Run command",
              tone: "tool",
              requestKind: "command",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        onForkConversation={() => {}}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Assistant text before hidden work.");
    expect(markup).toContain("Worked for 1s");
    expect(markup).not.toContain("Ran 1 command");
    expect(markup.indexOf("Worked for 1s")).toBeLessThan(
      markup.indexOf("Assistant text before hidden work."),
    );
    expect(markup.indexOf("Assistant text before hidden work.")).toBeLessThan(
      markup.indexOf('data-assistant-turn-footer="true"'),
    );
    expect(markup.indexOf('data-response-summary="true"')).toBeLessThan(
      markup.indexOf('aria-label="Fork conversation"'),
    );
  });

  it("does not render an assistant header for assistant messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "assistant-no-header-row",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-no-header-message"),
              role: "assistant",
              text: "Updated the timeline rendering.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-assistant-message-card="true"');
    expect(markup).not.toContain("Assistant");
    expect(markup).toContain("Updated the timeline rendering.");
  });

  it("keeps a trailing live intent inside the live status row when no tool has started yet", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "intent-only-live",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Inspecting the provider transcript before responding",
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-intent-message="true"');
    expect(markup).toContain('data-inline-intent="true"');
    expect(markup).toContain("Inspecting the provider transcript before responding");
    expect(markup).toContain("Getting started for");
    expect(markup).toContain('data-working-activity-indicator="true"');
    expect(markup).not.toContain("Thought");
  });

  it("measures the live working timer from the original user message after steering", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T19:13:00.000Z"));

    try {
      const { MessagesTimeline } = await import("./MessagesTimeline");
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          hasMessages
          isWorking
          activeTurnInProgress
          activeTurnStartedAt="2026-03-17T19:12:00.000Z"
          getScrollContainer={() => null}
          timelineEntries={[
            {
              id: "user-current-turn-original",
              kind: "message",
              createdAt: "2026-03-17T19:12:00.000Z",
              message: {
                id: MessageId.makeUnsafe("user-current-turn-original"),
                role: "user",
                text: "Implement the feature.",
                createdAt: "2026-03-17T19:12:00.000Z",
                streaming: false,
              },
            },
            {
              id: "assistant-current-turn",
              kind: "message",
              createdAt: "2026-03-17T19:12:42.000Z",
              message: {
                id: MessageId.makeUnsafe("assistant-current-turn"),
                role: "assistant",
                text: "Still working through the remaining checks.",
                createdAt: "2026-03-17T19:12:42.000Z",
                completedAt: "2026-03-17T19:12:45.000Z",
                streaming: false,
              },
            },
            {
              id: "user-current-turn-steer",
              kind: "message",
              createdAt: "2026-03-17T19:12:30.000Z",
              message: {
                id: MessageId.makeUnsafe("user-current-turn-steer"),
                role: "user",
                text: "Also update tests.",
                createdAt: "2026-03-17T19:12:30.000Z",
                streaming: false,
              },
            },
          ]}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />,
      );

      expect(markup).toContain("Working for 1m");
      expect(markup).toContain('data-working-activity-indicator="true"');
      expect(markup).not.toContain("Working for 30s");
      expect(markup).not.toContain('data-response-summary="true"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows separate getting-started and pursuing-goal timers for active Codex goal turns before output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T19:13:00.000Z"));

    try {
      const { MessagesTimeline } = await import("./MessagesTimeline");
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          hasMessages
          isWorking
          enableGoalWorkingState
          activeTurnInProgress
          activeTurnStartedAt="2026-03-17T19:12:00.000Z"
          getScrollContainer={() => null}
          timelineEntries={[
            {
              id: "user-goal-current-turn",
              kind: "message",
              createdAt: "2026-03-17T19:12:00.000Z",
              message: {
                id: MessageId.makeUnsafe("user-goal-current-turn"),
                role: "user",
                text: "/goal Ship the feature",
                createdAt: "2026-03-17T19:12:00.000Z",
                streaming: false,
              },
            },
            {
              id: "user-goal-current-turn-steer",
              kind: "message",
              createdAt: "2026-03-17T19:12:30.000Z",
              message: {
                id: MessageId.makeUnsafe("user-goal-current-turn-steer"),
                role: "user",
                text: "Keep it minimal.",
                createdAt: "2026-03-17T19:12:30.000Z",
                streaming: false,
              },
            },
          ]}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />,
      );

      expect(markup).toContain("Getting started for 1m");
      expect(markup).toContain("Pursuing goal for 1m");
      expect(markup).toContain('data-goal-working-timer="true"');
      expect(markup.match(/data-working-activity-indicator="true"/g)?.length).toBe(1);
      expect(markup).toContain("lucide-target");
      expect(markup).not.toContain("Getting started for 30s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the matching group id when expanding completed tool calls", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "intent-primary",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Running format and checks",
          },
          {
            id: "tool-burst-primary-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-burst-primary-1",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun fmt",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
          {
            id: "tool-burst-primary-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.100Z",
            entry: {
              id: "tool-burst-primary-2",
              createdAt: "2026-03-17T19:12:31.100Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun typecheck",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{
          "work-group:tool-burst-primary-1": true,
        }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Running format and checks");
    expect(markup).toContain('data-tool-disclosure-open="true"');
    expect(markup).toContain("bun fmt");
    expect(markup).toContain("bun typecheck");
    expect(markup).toContain('data-work-entry-id="tool-burst-primary-1"');
    expect(markup).toContain('data-work-entry-id="tool-burst-primary-2"');
  });

  it("keeps separate work disclosures isolated when they share a timestamp", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        getScrollContainer={() => null}
        timelineEntries={[
          {
            id: "thinking-first",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-first",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "First thinking block.",
              tone: "thinking",
            },
          },
          {
            id: "assistant-between-thinking",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-between-thinking"),
              role: "assistant",
              text: "keeping rows separate",
              createdAt: "2026-03-17T19:12:31.500Z",
              streaming: false,
            },
          },
          {
            id: "thinking-second",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-second",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "Second thinking block.",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-group:thinking-second": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/data-thinking-disclosure="true"/g) ?? []).toHaveLength(2);
    expect(markup).not.toContain('data-work-entry-id="thinking-first"');
    expect(markup).toContain('data-work-entry-id="thinking-second"');
  });
});
