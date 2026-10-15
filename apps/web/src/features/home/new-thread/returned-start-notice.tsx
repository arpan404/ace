import { LaptopIcon, XIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ClearStaleLock } from "@/features/thread/index.ts";
import type { ReturnedStart } from "@/lib/returned-start.ts";

/**
 * Why the last start from this composer came back (its worktree couldn't be made, or the daemon
 * refused it), in the composer's top strip while the message waits to be edited and sent again:
 * the daemon's title and detail for the failure. A worktree start offers the local checkout
 * instead, a stale Git lock offers to clear it (Send then retries); Dismiss gives the strip back.
 */
export function ReturnedStartNotice(props: {
  returned: ReturnedStart;
  worktree: boolean;
  workspaceId: string;
  onLocal(): void;
  onDismiss(): void;
}) {
  const { title, reason, code } = props.returned;
  return (
    <div role="alert" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <p className="min-w-0 grow basis-48 text-ui text-status-failed">
        {title && <span className="font-medium">{title}. </span>}
        {reason}
      </p>
      <span className="flex shrink-0 items-center gap-1">
        {code === "git_quarantined" && (
          <ClearStaleLock target={{ workspaceId: props.workspaceId }} onCleared={props.onDismiss} />
        )}
        {props.worktree && (
          <Button type="button" size="sm" variant="ghost" onClick={props.onLocal}>
            <Icon icon={LaptopIcon} size={14} />
            Don't use worktree
          </Button>
        )}
        <IconButton icon={XIcon} label="Dismiss" size="sm" onClick={props.onDismiss} />
      </span>
    </div>
  );
}
