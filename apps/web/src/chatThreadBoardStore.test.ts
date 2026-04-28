import { ThreadId } from "@ace/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useChatThreadBoardStore } from "./chatThreadBoardStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");

describe("chatThreadBoardStore", () => {
  beforeEach(() => {
    useChatThreadBoardStore.persist.clearStorage();
    useChatThreadBoardStore.setState({
      activeSplitId: null,
      activePaneId: null,
      paneRatios: [],
      panes: [],
      rows: [],
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

  it("reuses an existing pane when a saved board already contains the dragged thread", () => {
    const store = useChatThreadBoardStore.getState();
    const splitId = store.createSplit({
      activeThread: { threadId: THREAD_B },
      threads: [{ threadId: THREAD_A }, { threadId: THREAD_B }],
      title: "Board",
    });

    expect(splitId).toBeTruthy();

    const firstOpenPaneId = store.openThreadInSplit(splitId!, { threadId: THREAD_C });
    const reopenedPaneId = store.openThreadInSplit(splitId!, { threadId: THREAD_C });
    const split = useChatThreadBoardStore
      .getState()
      .splits.find((candidate) => candidate.id === splitId);

    expect(firstOpenPaneId).toBeTruthy();
    expect(reopenedPaneId).toBe(firstOpenPaneId);
    expect(split?.panes).toHaveLength(3);
    expect(split?.activePaneId).toBe(firstOpenPaneId);
  });
});
