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
    expect(orderBoardPanes(state.panes, state.layoutRoot).map((pane) => pane.id)).toEqual([
      state.panes[1]?.id,
      state.panes[0]?.id,
    ]);
    expect(state.panes.map((pane) => pane.threadId)).toEqual([THREAD_A, THREAD_B]);
    expect(state.activePaneId).toBe(state.panes[1]?.id);
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
      expect(orderBoardPanes(state.panes, state.layoutRoot).map((pane) => pane.id)).toEqual([
        state.panes[1]?.id,
        state.panes[0]?.id,
      ]);
    }
    expect(state.activePaneId).toBe(state.panes[1]?.id);
  });
});
