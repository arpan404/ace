import type { ThreadListEntry } from "@ace/protocol";
import {
  InlineRename,
  useOrganizeOverlay,
  useHomeSelection,
} from "@/features/organize/index.ts";

/** Only the title line changes; drafts survive a sidebar remount and refused saves reopen. */
export function RenameField(props: { entry: ThreadListEntry; title: string; onDone(): void }) {
  const overlay = useOrganizeOverlay();
  const selection = useHomeSelection();
  return (
    <InlineRename
      thread={props.entry}
      initialTitle={props.title}
      onTitleChange={(title) => selection.rename(props.entry.id, title)}
      onDone={() => {
        overlay.takeRefusedTitle(props.entry.id);
        props.onDone();
      }}
    />
  );
}
