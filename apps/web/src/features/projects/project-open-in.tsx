import { EditorIcon } from "@/components/editor-icon.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useEditors } from "@/lib/editors.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useEditorLaunch } from "@/lib/use-editor-launch.ts";

/** A registered project's folder opens with the same editor handoff as a thread. */
export function ProjectOpenIn(props: { projectId: string }) {
  const project = useProjectDirectory().projects.find((each) => each.id === props.projectId);
  const { editors, unavailable } = useEditors();
  const open = useEditorLaunch(async (editorId) => {
    const editor = editors?.find((each) => each.id === editorId);
    if (!project || !editor) throw new Error("That project or editor is unavailable. Try again.");
    return { editorId, editorName: editor.name, path: project.path };
  });
  if (!editors || !editors.length) return <MenuItem disabled>{unavailable}</MenuItem>;
  return editors.map((editor) => (
    <MenuItem
      key={editor.id}
      icon={<EditorIcon id={editor.id} />}
      disabled={open.isPending}
      onClick={() => open.mutate(editor.id)}
    >
      {editor.name}
    </MenuItem>
  ));
}
