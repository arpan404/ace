import type { InstalledEditor } from "@ace/protocol";
import { EditorIcon } from "@/components/editor-icon.tsx";
import { useEditorLaunch } from "@/lib/use-editor-launch.ts";
import { useEditorAppIcon, useEditors } from "@/lib/editors.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { RowButton, RowNote, rowIcon, SectionHead } from "./work-card-parts.tsx";

/**
 * Open in: the editors installed on the daemon's machine, each with its own app icon (from the
 * OS, in the desktop app; a neutral glyph in a browser). The last one used is the default and
 * comes first.
 */
export function OpenInSection(props: { thread: ThreadRef; onClose(): void }) {
  const sources = useThreadSources();
  const { editors, current, error } = useEditors();
  const open = useEditorLaunch(async (editorId) => {
    const launch = await sources.workspace.openIn(props.thread, editorId);
    return { editorId: launch.editor.id, editorName: launch.editor.name, path: launch.path };
  });
  const ordered = current
    ? [current, ...(editors ?? []).filter((editor) => editor.id !== current.id)]
    : (editors ?? []);
  return (
    <section aria-labelledby="work-card-open-in">
      <SectionHead id="work-card-open-in" title="Open in" />
      {!editors ? (
        <RowNote>{error ? "Couldn't list the editors" : "Looking for editors"}</RowNote>
      ) : !ordered.length ? (
        <RowNote>No editors found on this machine</RowNote>
      ) : (
        <ul aria-label="Editors" className="flex flex-col">
          {ordered.map((editor) => (
            <li key={editor.id}>
              <RowButton
                aria-label={`Open in ${editor.name}${editor.id === current?.id ? ", default" : ""}`}
                disabled={open.isPending}
                onClick={() => {
                  open.mutate(editor.id);
                  props.onClose();
                }}
              >
                <AppIcon editor={editor} />
                <span className="min-w-0 flex-1 truncate">{editor.name}</span>
                {editor.id === current?.id && (
                  <span className="shrink-0 text-xs text-subtle-foreground">default</span>
                )}
              </RowButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The app's own icon where the OS gave one, else the editor's glyph. */
function AppIcon(props: { editor: InstalledEditor }) {
  const icon = useEditorAppIcon(props.editor.id);
  if (icon)
    return (
      <img
        src={icon}
        alt=""
        data-app-icon={props.editor.id}
        width={16}
        height={16}
        className="size-4 shrink-0"
        draggable={false}
      />
    );
  return <EditorIcon id={props.editor.id} className={rowIcon} />;
}
