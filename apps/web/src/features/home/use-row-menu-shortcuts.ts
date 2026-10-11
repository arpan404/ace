import type { ThreadListEntry } from "@ace/protocol";
import type { ThreadRowFlags } from "@ace/ui-core";
import type { KeyboardEvent } from "react";
import { useThreadActions } from "@/features/organize/index.ts";
import { useKeys } from "@/lib/keybindings.ts";
import { matchesChord, parseChord } from "@/lib/hotkeys.ts";

/** A row's menu owns its displayed chords before the active thread's global handlers. */
export function useRowMenuShortcuts(props: {
  entry: ThreadListEntry;
  flags: ThreadRowFlags;
  onRename(): void;
  onClose(): void;
}) {
  const actions = useThreadActions();
  const rename = useKeys("renameThread");
  const pin = useKeys("pinThread");
  const archive = useKeys("archiveThread");
  return (event: KeyboardEvent) => {
    let run: (() => void) | undefined;
    if (matchesChord(event.nativeEvent, parseChord(rename))) run = props.onRename;
    else if (matchesChord(event.nativeEvent, parseChord(pin)))
      run = () => actions.setPinned(props.entry, !props.flags.pinned);
    else if (
      props.entry.archivedAt === undefined &&
      matchesChord(event.nativeEvent, parseChord(archive))
    )
      run = () => actions.archive(props.entry);
    if (!run) return;
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
    run();
  };
}
