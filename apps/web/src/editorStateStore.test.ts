import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_THREAD_EDITOR_TREE_WIDTH,
  selectThreadEditorState,
  useEditorStateStore,
} from "./editorStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("editorStateStore actions", () => {
  beforeEach(() => {
    useEditorStateStore.persist.clearStorage();
    useEditorStateStore.setState({
      runtimeStateByThreadId: {},
      threadStateByThreadId: {},
    });
  });

  it("returns a single-pane default editor state for unknown threads", () => {
    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );
    expect(editorState).toEqual({
      activePaneId: "pane-1",
      draftsByFilePath: {},
      expandedDirectoryPaths: [],
      paneRatios: [1],
      panes: [{ activeFilePath: null, id: "pane-1", openFilePaths: [] }],
      treeWidth: DEFAULT_THREAD_EDITOR_TREE_WIDTH,
    });
  });

  it("splits the active pane into a new window carrying the active file", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");

    const paneId = store.splitPane(THREAD_ID);
    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(paneId).toBe("pane-2");
    expect(editorState.activePaneId).toBe("pane-2");
    expect(editorState.paneRatios).toEqual([0.5, 0.5]);
    expect(editorState.panes).toEqual([
      { activeFilePath: "src/main.ts", id: "pane-1", openFilePaths: ["src/main.ts"] },
      { activeFilePath: "src/main.ts", id: "pane-2", openFilePaths: ["src/main.ts"] },
    ]);
  });

  it("opens files inside the explicitly targeted pane", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    const paneId = store.splitPane(THREAD_ID);
    expect(paneId).toBe("pane-2");

    store.setActivePane(THREAD_ID, "pane-1");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts", "pane-2");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.activePaneId).toBe("pane-2");
    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/utils.ts",
        id: "pane-1",
        openFilePaths: ["src/main.ts", "src/utils.ts"],
      },
      {
        activeFilePath: "src/sidebar.ts",
        id: "pane-2",
        openFilePaths: ["src/main.ts", "src/sidebar.ts"],
      },
    ]);
  });

  it("closes panes while keeping a valid active pane and normalized ratios", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.splitPane(THREAD_ID);

    store.closePane(THREAD_ID, "pane-1");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.activePaneId).toBe("pane-2");
    expect(editorState.paneRatios).toEqual([1]);
    expect(editorState.panes).toEqual([
      { activeFilePath: "src/main.ts", id: "pane-2", openFilePaths: ["src/main.ts"] },
    ]);
  });

  it("prunes invalid file references across panes without dropping the split layout", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.splitPane(THREAD_ID);
    store.openFile(THREAD_ID, "src/sidebar.ts", "pane-2");

    store.syncTree(THREAD_ID, ["src", "src/sidebar.ts"]);

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.paneRatios).toEqual([0.5, 0.5]);
    expect(editorState.panes).toEqual([
      { activeFilePath: null, id: "pane-1", openFilePaths: [] },
      { activeFilePath: "src/sidebar.ts", id: "pane-2", openFilePaths: ["src/sidebar.ts"] },
    ]);
  });
});
