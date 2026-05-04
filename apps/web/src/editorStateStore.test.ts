import { ThreadId } from "@ace/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_THREAD_EDITOR_TREE_WIDTH,
  resolveEditorStateScopeId,
  selectThreadEditorState,
  useEditorStateStore,
} from "./editorStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-2");

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
      codeComments: [],
      draftsByFilePath: {},
      expandedDirectoryPaths: [],
      explorerOpen: true,
      paneRatios: [1],
      panes: [{ activeFilePath: null, id: "pane-1", openFilePaths: [] }],
      rows: [{ id: "row-1", paneIds: ["pane-1"], paneRatios: [1] }],
      treeWidth: DEFAULT_THREAD_EDITOR_TREE_WIDTH,
    });
  });

  it("reuses the selected editor state reference when the thread slice is unchanged", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");

    const state = useEditorStateStore.getState();
    const firstEditorState = selectThreadEditorState(
      state.threadStateByThreadId,
      state.runtimeStateByThreadId,
      THREAD_ID,
    );
    const secondEditorState = selectThreadEditorState(
      state.threadStateByThreadId,
      state.runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(secondEditorState).toBe(firstEditorState);
  });

  it("keeps the selected editor state stable across unrelated thread updates", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");

    const stateBeforeUnrelatedUpdate = useEditorStateStore.getState();
    const editorStateBeforeUnrelatedUpdate = selectThreadEditorState(
      stateBeforeUnrelatedUpdate.threadStateByThreadId,
      stateBeforeUnrelatedUpdate.runtimeStateByThreadId,
      THREAD_ID,
    );

    store.openFile(OTHER_THREAD_ID, "src/other.ts");

    const stateAfterUnrelatedUpdate = useEditorStateStore.getState();
    const editorStateAfterUnrelatedUpdate = selectThreadEditorState(
      stateAfterUnrelatedUpdate.threadStateByThreadId,
      stateAfterUnrelatedUpdate.runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorStateAfterUnrelatedUpdate).toBe(editorStateBeforeUnrelatedUpdate);
  });

  it("shares editor state across threads in the same project", () => {
    const store = useEditorStateStore.getState();
    const firstProjectScope = resolveEditorStateScopeId({
      gitCwd: "/tmp/project",
      threadId: THREAD_ID,
    });
    const secondProjectScope = resolveEditorStateScopeId({
      gitCwd: "/tmp/project",
      threadId: OTHER_THREAD_ID,
    });

    store.openFile(firstProjectScope, "src/main.ts");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      secondProjectScope,
    );

    expect(editorState.panes).toEqual([
      { activeFilePath: "src/main.ts", id: "pane-1", openFilePaths: ["src/main.ts"] },
    ]);
  });

  it("keeps editor state isolated when project changes", () => {
    const store = useEditorStateStore.getState();
    const firstProjectScope = resolveEditorStateScopeId({
      gitCwd: "/tmp/project-a",
      threadId: THREAD_ID,
    });
    const secondProjectScope = resolveEditorStateScopeId({
      gitCwd: "/tmp/project-b",
      threadId: THREAD_ID,
    });

    store.openFile(firstProjectScope, "src/main.ts");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      secondProjectScope,
    );

    expect(editorState.panes).toEqual([{ activeFilePath: null, id: "pane-1", openFilePaths: [] }]);
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
    expect(editorState.paneRatios).toEqual([1]);
    expect(editorState.panes).toEqual([
      { activeFilePath: "src/main.ts", id: "pane-1", openFilePaths: ["src/main.ts"] },
      { activeFilePath: "src/main.ts", id: "pane-2", openFilePaths: ["src/main.ts"] },
    ]);
    expect(editorState.rows).toEqual([
      { id: "row-1", paneIds: ["pane-1", "pane-2"], paneRatios: [0.5, 0.5] },
    ]);
  });

  it("splits the active pane downward into a second editor row", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");

    const paneId = store.splitPane(THREAD_ID, { direction: "down" });
    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(paneId).toBe("pane-2");
    expect(editorState.activePaneId).toBe("pane-2");
    expect(editorState.paneRatios).toEqual([0.5, 0.5]);
    expect(editorState.rows).toEqual([
      { id: "row-1", paneIds: ["pane-1"], paneRatios: [1] },
      { id: "row-2", paneIds: ["pane-2"], paneRatios: [1] },
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

  it("reorders tabs within a pane while keeping the moved tab active", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts");

    store.moveFile(THREAD_ID, {
      filePath: "src/sidebar.ts",
      sourcePaneId: "pane-1",
      targetPaneId: "pane-1",
      targetIndex: 0,
    });

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.activePaneId).toBe("pane-1");
    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/sidebar.ts",
        id: "pane-1",
        openFilePaths: ["src/sidebar.ts", "src/main.ts", "src/utils.ts"],
      },
    ]);
  });

  it("keeps before-target ordering when reordering a tab forward within a pane", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts");

    store.moveFile(THREAD_ID, {
      filePath: "src/main.ts",
      sourcePaneId: "pane-1",
      targetPaneId: "pane-1",
      targetIndex: 2,
    });

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.activePaneId).toBe("pane-1");
    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/main.ts",
        id: "pane-1",
        openFilePaths: ["src/utils.ts", "src/main.ts", "src/sidebar.ts"],
      },
    ]);
  });

  it("moves tabs across panes and repairs source-pane selection", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.splitPane(THREAD_ID);
    store.openFile(THREAD_ID, "src/sidebar.ts", "pane-2");

    store.moveFile(THREAD_ID, {
      filePath: "src/utils.ts",
      sourcePaneId: "pane-1",
      targetPaneId: "pane-2",
      targetIndex: 1,
    });

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.activePaneId).toBe("pane-2");
    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/main.ts",
        id: "pane-1",
        openFilePaths: ["src/main.ts"],
      },
      {
        activeFilePath: "src/utils.ts",
        id: "pane-2",
        openFilePaths: ["src/sidebar.ts", "src/utils.ts"],
      },
    ]);
  });

  it("closes other tabs while preserving the selected tab", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts");

    store.closeOtherFiles(THREAD_ID, "src/utils.ts");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/utils.ts",
        id: "pane-1",
        openFilePaths: ["src/utils.ts"],
      },
    ]);
  });

  it("closes tabs to the right and repairs active selection if needed", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts");
    store.openFile(THREAD_ID, "src/routes.ts");

    store.closeFilesToRight(THREAD_ID, "src/utils.ts");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/utils.ts",
        id: "pane-1",
        openFilePaths: ["src/main.ts", "src/utils.ts"],
      },
    ]);
  });

  it("reopens the most recently closed tab in its prior pane position", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts");

    store.closeFile(THREAD_ID, "src/utils.ts");
    const reopenedPath = store.reopenClosedFile(THREAD_ID);

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(reopenedPath).toBe("src/utils.ts");
    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/utils.ts",
        id: "pane-1",
        openFilePaths: ["src/main.ts", "src/utils.ts", "src/sidebar.ts"],
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
    expect(editorState.rows).toEqual([{ id: "row-1", paneIds: ["pane-2"], paneRatios: [1] }]);
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

    expect(editorState.paneRatios).toEqual([1]);
    expect(editorState.panes).toEqual([
      { activeFilePath: null, id: "pane-1", openFilePaths: [] },
      { activeFilePath: "src/sidebar.ts", id: "pane-2", openFilePaths: ["src/sidebar.ts"] },
    ]);
    expect(editorState.rows).toEqual([
      { id: "row-1", paneIds: ["pane-1", "pane-2"], paneRatios: [0.5, 0.5] },
    ]);
  });

  it("renames open file references and preserved drafts", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.hydrateFile(THREAD_ID, "src/main.ts", "export const value = 1;\n");
    store.updateDraft(THREAD_ID, "src/main.ts", "export const value = 2;\n");

    store.renameEntry(THREAD_ID, "src/main.ts", "src/app.ts");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.panes).toEqual([
      { activeFilePath: "src/app.ts", id: "pane-1", openFilePaths: ["src/app.ts"] },
    ]);
    expect(editorState.draftsByFilePath).toEqual({
      "src/app.ts": {
        draftContents: "export const value = 2;\n",
        savedContents: "export const value = 1;\n",
      },
    });
  });

  it("tracks code comments by file range and updates their status", () => {
    const store = useEditorStateStore.getState();
    store.addCodeComment(THREAD_ID, {
      body: "Check this branch.",
      code: "if (ready) return;",
      createdAt: "2026-05-04T12:00:00.000Z",
      cwd: "/repo",
      id: "comment-1",
      range: {
        relativePath: "src/main.ts",
        startLine: 4,
        startColumn: 0,
        endLine: 4,
        endColumn: 18,
      },
      relativePath: "src/main.ts",
      source: "user",
      status: "open",
    });

    store.updateCodeCommentStatus(THREAD_ID, "comment-1", "queued");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.codeComments).toEqual([
      expect.objectContaining({
        code: "if (ready) return;",
        relativePath: "src/main.ts",
        status: "queued",
      }),
    ]);
  });

  it("renames and removes code comments with their files", () => {
    const store = useEditorStateStore.getState();
    store.addCodeComment(THREAD_ID, {
      body: "Keep this anchored.",
      code: "export const value = 1;",
      createdAt: "2026-05-04T12:00:00.000Z",
      cwd: "/repo",
      id: "comment-1",
      range: {
        relativePath: "src/main.ts",
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 21,
      },
      relativePath: "src/main.ts",
      source: "user",
      status: "open",
    });

    store.renameEntry(THREAD_ID, "src/main.ts", "src/app.ts");

    let editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );
    expect(editorState.codeComments[0]?.relativePath).toBe("src/app.ts");
    expect(editorState.codeComments[0]?.range.relativePath).toBe("src/app.ts");

    store.removeEntry(THREAD_ID, "src");
    editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );
    expect(editorState.codeComments).toEqual([]);
  });

  it("removes deleted directory references from panes and drafts", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils/helpers.ts");
    store.hydrateFile(THREAD_ID, "src/utils/helpers.ts", "export const help = true;\n");
    store.expandDirectories(THREAD_ID, ["src", "src/utils"]);

    store.removeEntry(THREAD_ID, "src/utils");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.expandedDirectoryPaths).toEqual(["src"]);
    expect(editorState.panes).toEqual([
      { activeFilePath: "src/main.ts", id: "pane-1", openFilePaths: ["src/main.ts"] },
    ]);
    expect(editorState.draftsByFilePath).toEqual({});
  });
});
