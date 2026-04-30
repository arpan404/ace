import { ThreadId } from "@ace/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { orderBoardPanes, useChatThreadBoardStore } from "./chatThreadBoardStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");

describe("chatThreadBoardStore", () => {
  beforeEach(() => {
    useChatThreadBoardStore.persist.clearStorage();
    useChatThreadBoardStore.setState({
      activePaneId: null,
      activeSplitId: null,
      layoutRoot: null,
      panes: [],
      splits: [],
    });
  });

  it("adds a thread to an existing saved board and focuses the new pane", () => {
    const store = useChatThreadBoardStore.getState();
    const splitId = store.createSplit({
      activeThread: { threadId: THREAD_B },
      threads: [{ threadId: THREAD_A }, { threadId: THREAD_B }],
      title: "Board",
    });

    expect(splitId).toBeTruthy();

    const openedPaneId = store.openThreadInSplit(splitId!, { threadId: THREAD_C });
    const state = useChatThreadBoardStore.getState();
    const split = state.splits.find((candidate) => candidate.id === splitId);

    expect(openedPaneId).toBeTruthy();
    expect(split?.panes.map((pane) => pane.threadId)).toEqual([THREAD_A, THREAD_B, THREAD_C]);
    expect(split?.activePaneId).toBe(openedPaneId);
    expect(state.activeSplitId).toBe(splitId);
    expect(state.activePaneId).toBe(openedPaneId);
    expect(state.panes.map((pane) => pane.threadId)).toEqual([THREAD_A, THREAD_B, THREAD_C]);
  });

  it("focuses an existing saved-board pane by default instead of duplicating it", () => {
    const store = useChatThreadBoardStore.getState();
    const splitId = store.createSplit({
      activeThread: { threadId: THREAD_B },
      threads: [{ threadId: THREAD_A }, { threadId: THREAD_B }],
      title: "Board",
    });

    expect(splitId).toBeTruthy();

    const originalSplit = useChatThreadBoardStore
      .getState()
      .splits.find((candidate) => candidate.id === splitId);
    const existingPaneId = originalSplit?.panes.find((pane) => pane.threadId === THREAD_A)?.id;
    const openedPaneId = store.openThreadInSplit(splitId!, { threadId: THREAD_A });
    const split = useChatThreadBoardStore
      .getState()
      .splits.find((candidate) => candidate.id === splitId);

    expect(openedPaneId).toBe(existingPaneId);
    expect(split?.panes).toHaveLength(2);
    expect(split?.panes.map((pane) => pane.threadId)).toEqual([THREAD_A, THREAD_B]);
    expect(split?.activePaneId).toBe(existingPaneId);
  });

  it("focuses an existing active-board pane by default instead of duplicating it", () => {
    const store = useChatThreadBoardStore.getState();
    const sourcePaneId = store.syncRouteThread({ threadId: THREAD_A });

    store.openThreadInBoard({ sourcePaneId, threadId: THREAD_B });
    const firstState = useChatThreadBoardStore.getState();
    const existingPaneId = firstState.panes.find((pane) => pane.threadId === THREAD_B)?.id;
    const reopenedPaneId = store.openThreadInBoard({ sourcePaneId, threadId: THREAD_B });
    const state = useChatThreadBoardStore.getState();

    expect(reopenedPaneId).toBe(existingPaneId);
    expect(state.panes).toHaveLength(2);
    expect(state.panes.filter((pane) => pane.threadId === THREAD_B)).toHaveLength(1);
    expect(state.activePaneId).toBe(existingPaneId);
  });

  it("skips existing panes when bulk-opening threads into the active board", () => {
    const store = useChatThreadBoardStore.getState();
    const sourcePaneId = store.syncRouteThread({ threadId: THREAD_A });

    store.openThreadInBoard({ sourcePaneId, threadId: THREAD_B });
    const firstState = useChatThreadBoardStore.getState();
    const existingPaneId = firstState.panes.find((pane) => pane.threadId === THREAD_B)?.id;
    const lastOpenedPaneId = store.openThreadsInBoard([
      { threadId: THREAD_B },
      { threadId: THREAD_C },
    ]);
    const state = useChatThreadBoardStore.getState();

    expect(lastOpenedPaneId).toBe(state.panes.find((pane) => pane.threadId === THREAD_C)?.id);
    expect(state.panes.map((pane) => pane.threadId)).toEqual([THREAD_A, THREAD_B, THREAD_C]);
    expect(state.panes.filter((pane) => pane.threadId === THREAD_B)).toHaveLength(1);
    expect(state.panes.find((pane) => pane.threadId === THREAD_B)?.id).toBe(existingPaneId);
  });

  it("moves an existing pane relative to another pane without duplicating threads", () => {
    const store = useChatThreadBoardStore.getState();
    const firstPaneId = store.syncRouteThread({ threadId: THREAD_A });

    store.openThreadsInBoard([{ threadId: THREAD_B }, { threadId: THREAD_C }], {
      sourcePaneId: firstPaneId,
    });
    const beforeMove = useChatThreadBoardStore.getState();
    const sourcePaneId = beforeMove.panes.find((pane) => pane.threadId === THREAD_C)?.id;
    const targetPaneId = beforeMove.panes.find((pane) => pane.threadId === THREAD_A)?.id;

    expect(sourcePaneId).toBeTruthy();
    expect(targetPaneId).toBeTruthy();

    const movedPaneId = store.movePane({
      direction: "left",
      paneId: sourcePaneId!,
      targetPaneId: targetPaneId!,
    });
    const state = useChatThreadBoardStore.getState();

    expect(movedPaneId).toBe(sourcePaneId);
    expect(orderBoardPanes(state.panes, state.layoutRoot).map((pane) => pane.threadId)).toEqual([
      THREAD_C,
      THREAD_A,
      THREAD_B,
    ]);
    expect(state.panes).toHaveLength(3);
    expect(state.activePaneId).toBe(sourcePaneId);
  });

  it("can open duplicate panes for the same thread in a saved board when explicitly allowed", () => {
    const store = useChatThreadBoardStore.getState();
    const splitId = store.createSplit({
      activeThread: { threadId: THREAD_B },
      threads: [{ threadId: THREAD_A }, { threadId: THREAD_B }],
      title: "Board",
    });

    expect(splitId).toBeTruthy();

    const firstOpenPaneId = store.openThreadInSplit(splitId!, {
      allowDuplicate: true,
      threadId: THREAD_C,
    });
    const reopenedPaneId = store.openThreadInSplit(splitId!, {
      allowDuplicate: true,
      threadId: THREAD_C,
    });
    const split = useChatThreadBoardStore
      .getState()
      .splits.find((candidate) => candidate.id === splitId);

    expect(firstOpenPaneId).toBeTruthy();
    expect(reopenedPaneId).toBeTruthy();
    expect(reopenedPaneId).not.toBe(firstOpenPaneId);
    expect(split?.panes).toHaveLength(4);
    expect(split?.panes.filter((pane) => pane.threadId === THREAD_C)).toHaveLength(2);
    expect(split?.activePaneId).toBe(reopenedPaneId);
  });

  it("inserts a thread before the source pane when opening to the left", () => {
    const store = useChatThreadBoardStore.getState();
    const sourcePaneId = store.syncRouteThread({ threadId: THREAD_A });

    store.openThreadInBoard({
      direction: "left",
      sourcePaneId,
      threadId: THREAD_B,
    });

    const state = useChatThreadBoardStore.getState();
    const openedPaneId = state.panes.find((pane) => pane.threadId === THREAD_B)?.id;
    expect(orderBoardPanes(state.panes, state.layoutRoot).map((pane) => pane.threadId)).toEqual([
      THREAD_B,
      THREAD_A,
    ]);
    expect(state.activePaneId).toBe(openedPaneId);
    expect(state.activeSplitId).toBeTruthy();
  });

  it("inserts a thread above the source pane when opening upward", () => {
    const store = useChatThreadBoardStore.getState();
    const sourcePaneId = store.syncRouteThread({ threadId: THREAD_A });

    store.openThreadInBoard({
      direction: "up",
      sourcePaneId,
      threadId: THREAD_B,
    });

    const state = useChatThreadBoardStore.getState();
    expect(state.layoutRoot?.kind).toBe("split");
    if (state.layoutRoot?.kind === "split") {
      expect(state.layoutRoot.axis).toBe("vertical");
      expect(orderBoardPanes(state.panes, state.layoutRoot).map((pane) => pane.threadId)).toEqual([
        THREAD_B,
        THREAD_A,
      ]);
    }
    expect(state.activePaneId).toBe(state.panes.find((pane) => pane.threadId === THREAD_B)?.id);
    expect(state.activeSplitId).toBeTruthy();
  });

  it("syncs a single route thread into a clean one-pane board", () => {
    const store = useChatThreadBoardStore.getState();
    const splitId = store.createSplit({
      activeThread: { threadId: THREAD_B },
      threads: [{ threadId: THREAD_A }, { threadId: THREAD_B }],
      title: "Board",
    });

    expect(splitId).toBeTruthy();

    const paneId = store.syncRouteThread({ threadId: THREAD_C });
    const state = useChatThreadBoardStore.getState();

    expect(state.activeSplitId).toBeNull();
    expect(state.activePaneId).toBe(paneId);
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.threadId).toBe(THREAD_C);
    expect(orderBoardPanes(state.panes, state.layoutRoot).map((pane) => pane.threadId)).toEqual([
      THREAD_C,
    ]);
    expect(state.splits.find((candidate) => candidate.id === splitId)?.panes).toHaveLength(2);
  });

  it("dissolves the active saved board when closing down to one pane", () => {
    const store = useChatThreadBoardStore.getState();
    const splitId = store.createSplit({
      activeThread: { threadId: THREAD_B },
      threads: [{ threadId: THREAD_A }, { threadId: THREAD_B }],
      title: "Board",
    });

    expect(splitId).toBeTruthy();

    const paneToClose = useChatThreadBoardStore
      .getState()
      .panes.find((pane) => pane.threadId === THREAD_B);
    expect(paneToClose).toBeTruthy();

    store.closePane(paneToClose!.id);
    const state = useChatThreadBoardStore.getState();

    expect(state.activeSplitId).toBeNull();
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.threadId).toBe(THREAD_A);
    expect(state.splits.some((split) => split.id === splitId)).toBe(false);
  });
});
