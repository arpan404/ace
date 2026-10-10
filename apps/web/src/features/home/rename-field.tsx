import type { ThreadListEntry } from "@ace/protocol";
import { InlineRename, useOrganizeOverlay } from "@/features/organize/index.ts";
/** Only the title line changes; project and branch remain visible. */
export function RenameField(props: { entry: ThreadListEntry; title: string; onDone(): void }) {
  const overlay = useOrganizeOverlay();
  return (
    <InlineRename
      key={props.title}
      thread={props.entry}
      initialTitle={props.title}
      onDone={() => {
        overlay.takeRefusedTitle(props.entry.id);
        props.onDone();
      }}
    />
  );
}
