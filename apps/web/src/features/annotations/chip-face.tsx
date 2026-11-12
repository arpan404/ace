import { ChatTeardropTextIcon, XIcon } from "@phosphor-icons/react";
import type { ComponentType, ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";

/** What the chip's count button carries, whichever element draws it. */
export interface ChipTrigger {
  "aria-label": string;
  className: string;
  children: ReactNode;
}

/**
 * The annotation chip's face: the count that opens the list, and the button that removes them
 * all. `trigger` draws the count button: the popover's trigger once its code has loaded.
 */
export function ChipFace(props: {
  label: string;
  onClear(): void;
  trigger: ComponentType<ChipTrigger>;
}) {
  const Trigger = props.trigger;
  return (
    <div className="inline-flex h-8 max-w-full min-w-0 items-center gap-0.5 rounded-md border border-sidebar-border bg-background/50 pr-1 pl-1">
      <Trigger
        aria-label={`Show ${props.label}`}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1 text-ui leading-4 text-foreground focus-ring hover:text-foreground aria-expanded:text-foreground"
      >
        <ChatTeardropTextIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
        <span className="truncate tabular-nums">{props.label}</span>
      </Trigger>
      <IconButton
        icon={XIcon}
        label="Remove all annotations"
        size="sm"
        tooltip={false}
        onClick={props.onClear}
      />
    </div>
  );
}

/** The count button while the list's code is on its way: the same button, not yet a trigger. */
export function PendingTrigger(props: ChipTrigger) {
  return <button type="button" {...props} />;
}
