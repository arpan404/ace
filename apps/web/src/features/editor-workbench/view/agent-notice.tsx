import { Button } from "@/components/ui/button.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { noticeClash, type EditorBuffers } from "./editor-buffers.ts";
import type { BufferSnapshot } from "../buffers/index.ts";

/**
 * Spec 46: the moment the disk version moves under unsaved edits, one line under the group's
 * breadcrumbs names who changed the file, with Merge and Compare. While comparing, the line
 * also answers for the whole file (Keep mine, Take theirs) and leads back to the editor. It
 * stays until an answer or a save clears the registry's clash; Merge waits while one runs.
 */
export function AgentNotice(props: {
  snapshot: BufferSnapshot | undefined;
  buffers: EditorBuffers;
  comparing: boolean;
  onMerge(): void;
  /** Unset: nothing to compare with. */
  onCompare?: (() => void) | undefined;
  onKeepMine(): void;
  onTakeTheirs(): void;
}) {
  const clash = noticeClash(props.snapshot);
  if (!clash) return null;
  const changer = props.buffers.changer(clash.by);
  const busy = clash.kind === "merging";
  return (
    <div
      role="status"
      data-part="editor-notice"
      className="flex h-9 shrink-0 items-center gap-2 border-y border-border pr-2.5 pl-3.5 text-ui whitespace-nowrap text-foreground"
    >
      {changer?.provider && <ProviderIcon provider={changer.provider} size={14} decorative />}
      <span className="min-w-0 flex-1 truncate">
        {changer ? `${changer.name} also changed this file.` : "This file changed on disk."}
      </span>
      <Button size="sm" disabled={busy} onClick={props.onMerge}>
        Merge
      </Button>
      {props.comparing && (
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onKeepMine}>
            Keep mine
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onTakeTheirs}>
            Take theirs
          </Button>
        </>
      )}
      {props.onCompare && (
        <Button size="sm" variant="ghost" onClick={props.onCompare}>
          {props.comparing ? "Back to editor" : "Compare"}
        </Button>
      )}
    </div>
  );
}
