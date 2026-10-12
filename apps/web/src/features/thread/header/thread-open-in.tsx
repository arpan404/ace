import { FolderOpenIcon } from "@phosphor-icons/react";
import { RowButton, TruncatedText, rowIcon } from "./work-card-parts.tsx";
import { useFolderActions } from "../lib/folder-actions.ts";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { useThreadMeta } from "@ace/client-react";
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

function useThreadEditorLaunch(thread: ThreadRef) {
  const sources = useThreadSources();
  return useEditorLaunch(async (editorId) => {
    const launch = await sources.workspace.openIn(thread, editorId);
    return { editorId: launch.editor.id, editorName: launch.editor.name, path: launch.path };
  });
}

/** Open locally in the file manager, or hand off to a daemon-installed editor. */
export function ThreadOpenButton(props: { thread: ThreadRef }) {
  const details = useThreadMeta(props.thread.id)?.details;
  const machine = useMachineIdentity(details?.machine);
  const folder = useFolderActions(details?.worktree ?? details?.workspace?.path);
  const { editors, current, unavailable } = useEditors();
  const editor = current ?? editors?.[0];
  const launch = useThreadEditorLaunch(props.thread);
  const local = machine.primary && folder.reveal;
  const label = local
    ? folder.revealLabel === "Show in Finder"
      ? "Open in Finder"
      : "Open in file manager"
    : editor
      ? `Open in ${editor.name}`
      : "Open checkout";
  return (
    <RowButton
      className="flex-1"
      disabled={launch.isPending || (!local && !editor)}
      aria-description={!local && !editor ? unavailable : undefined}
      onClick={() => {
        if (local) local();
        else if (editor) launch.mutate(editor.id);
      }}
    >
      {local ? (
        <FolderOpenIcon aria-hidden size={16} className={rowIcon} />
      ) : editor ? (
        <EditorIcon id={editor.id} />
      ) : (
        <FolderOpenIcon aria-hidden size={16} className={rowIcon} />
      )}
      <TruncatedText>{label}</TruncatedText>
    </RowButton>
  );
}
