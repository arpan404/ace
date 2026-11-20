/*
 * The one way a checkout file opens: into the thread's editor (docs/editor/workbench.md 8). The
 * rule lives in the foundation (`lib/workspace/editor-tab.ts`) so every opener reaches it; the
 * Files explorer, search and quick open use it from here.
 */
export {
  openInEditorPanel,
  useOpenInEditorPanel,
  type EditorPanelTarget,
  type OpenInEditorPanelOptions,
} from "@/lib/workspace/index.ts";
