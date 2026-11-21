import type { ScopeWorkspace } from "@ace/ui-core/workspace-tabs";
import { expect, test, vi } from "vitest";
import type { WorkspaceActions } from "./actions.ts";
import { editorKind, openInEditorPanel, type EditorPanelTarget } from "./editor-tab.ts";

/*
 * Spec 4: when a file opens and the docked panel is narrower than 640px, the panel widens to
 * 640px, once per opening; a width the person drags afterwards is kept.
 */

const layout = (paths: string[]) => ({
  root: {
    kind: "group",
    id: "g1",
    tabs: paths.map((path) => ({ path, preview: false, pinned: false })),
    active: paths[0],
    mru: paths,
  },
  focused: "g1",
});

function target(workspace: Partial<ScopeWorkspace>) {
  const setSize = vi.fn();
  const actions: Partial<WorkspaceActions> = { open: () => {}, setSize };
  const shown: ScopeWorkspace = {
    tabs: [],
    active: undefined,
    open: false,
    size: 480,
    expanded: false,
    ...workspace,
  };
  const editor: EditorPanelTarget = {
    scope: "t1",
    read: () => shown,
    actions: actions as WorkspaceActions,
  };
  return { editor, setSize };
}

const editorTab = (paths: string[]) => ({
  tabs: [{ key: editorKind, kind: editorKind, id: "", pinned: false, data: layout(paths) }],
  active: editorKind,
  open: true,
});

test("the first file opened in an editor already showing its explorer widens a 480px panel to 640px", () => {
  const { editor, setSize } = target(editorTab([]));
  openInEditorPanel(editor, "src/a.ts", { keep: true });
  expect(setSize).toHaveBeenCalledWith(640, true);
});

test("opening the editor with a file widens a 480px panel to 640px", () => {
  const { editor, setSize } = target({});
  openInEditorPanel(editor, "src/a.ts");
  expect(setSize).toHaveBeenCalledWith(640, true);
});

test("a second file opened while one shows keeps the width the person chose", () => {
  const { editor, setSize } = target(editorTab(["src/a.ts"]));
  openInEditorPanel(editor, "src/b.ts", { keep: true });
  expect(setSize).not.toHaveBeenCalled();
});

test("a panel already 640px wide or more is left as it is", () => {
  const { editor, setSize } = target({ ...editorTab([]), size: 720 });
  openInEditorPanel(editor, "src/a.ts");
  expect(setSize).not.toHaveBeenCalled();
});
