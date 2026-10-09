import { ArrowUUpLeftIcon, CheckIcon } from "@phosphor-icons/react";
import type { ThreadListEntry } from "@ace/protocol";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useThreadActions } from "@/features/organize/index.ts";

/** One quick action replaces the marks. Snooze and Pin live in the context menu. */
export function RowActions(props: { entry: ThreadListEntry; settled: boolean }) {
  const actions = useThreadActions();
  const { entry, settled } = props;
  return (
    <div className="absolute top-0 right-1 hidden items-center group-focus-within/row:flex group-hover/row:flex group-data-popup-open/row:invisible">
      <IconButton
        icon={settled ? ArrowUUpLeftIcon : CheckIcon}
        size="sm"
        label={`${settled ? "Unsettle" : "Settle"} ${entry.title}`}
        tip={settled ? "Unsettle" : "Settle"}
        disabled={!settled && entry.status.state !== "done"}
        reason={
          !settled && entry.status.state !== "done" ? "Settle after the task finishes" : undefined
        }
        onClick={() => (settled ? actions.unsettle(entry) : actions.settle(entry))}
      />
    </div>
  );
}
