import { IconButton } from "@/components/ui/icon-button.tsx";
import { settleAction, useThreadActions } from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { RowMoreMenu, type RowActionsProps } from "./row-actions.tsx";

/**
 * A chat row's hover and focus actions at its right edge: Settle (or Unsettle) as a bare icon
 * where the chat allows it, then the ⋯ menu. The ⋯ menu holds the same items as the row's
 * right-click menu, so the two never differ.
 */
export function ChatRowActions(props: RowActionsProps) {
  const actions = useThreadActions();
  const settle = settleAction(props.entry, props.flags, actions);
  const title = props.entry.title;
  return (
    <div
      // Centred on the row's one line, so the row never moves.
      className={cn(
        "absolute top-1/2 right-1.5 -translate-y-1/2 items-center gap-0.5",
        props.shown ? "flex" : "hidden has-[[data-popup-open]]:flex",
      )}
      role="presentation"
      onPointerEnter={props.onHover}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {settle && (
        <IconButton
          icon={settle.icon}
          size="sm"
          label={`${settle.label} ${title}`}
          tip={settle.label}
          tabIndex={-1}
          onClick={settle.run}
        />
      )}
      <RowMoreMenu entry={props.entry} flags={props.flags} onRename={props.onRename} />
    </div>
  );
}
