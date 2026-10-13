import { LaptopIcon, XIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";

/**
 * Why the last start from this composer came back (its worktree couldn't be made, or the daemon
 * refused it), in the composer's top strip while the message waits to be edited and sent again.
 * A worktree start offers the local checkout instead; Dismiss gives the strip back.
 */
export function ReturnedStartNotice(props: {
  reason: string;
  worktree: boolean;
  onLocal(): void;
  onDismiss(): void;
}) {
  return (
    <div role="alert" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <p className="min-w-0 grow basis-48 text-ui text-status-failed">{props.reason}</p>
      <span className="flex shrink-0 items-center gap-1">
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
