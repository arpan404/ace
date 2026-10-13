import { EditorIcon } from "@/components/editor-icon.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useEditorLaunch } from "@/lib/use-editor-launch.ts";
import { useEditors } from "@/lib/editors.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";

/** Installed editors for this thread's daemon; the last successful handoff comes first. */
export function ThreadOpenIn(props: { thread: ThreadRef }) {
  const { editors, current, unavailable } = useEditors();
  const open = useThreadEditorLaunch(props.thread);
  if (!editors || !editors.length) return <MenuItem disabled>{unavailable}</MenuItem>;
  const ordered = current
    ? [current, ...editors.filter((editor) => editor.id !== current.id)]
    : editors;
  return ordered.map((editor) => (
    <MenuItem
      key={editor.id}
      aria-label={`Open in ${editor.name}${editor.id === current?.id ? ", default" : ""}`}
      icon={<EditorIcon id={editor.id} />}
      disabled={open.isPending}
      onClick={() => open.mutate(editor.id)}
    >
      {editor.name}
      {editor.id === current?.id && (
        <span className="ml-3 text-xs text-subtle-foreground">default</span>
      )}
    </MenuItem>
  ));
}

/** Hand the thread's checkout to an installed editor, remembering it as the default. */
export function useThreadEditorLaunch(thread: ThreadRef) {
  const sources = useThreadSources();
  return useEditorLaunch(async (editorId) => {
    const launch = await sources.workspace.openIn(thread, editorId);
    return { editorId: launch.editor.id, editorName: launch.editor.name, path: launch.path };
  });
}
