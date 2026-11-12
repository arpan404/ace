import { ChatTeardropTextIcon, XIcon } from "@phosphor-icons/react";
import type { RefObject } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";

/**
 * The annotation chip's face: the count that opens the list, and the button that removes them
 * all. The count is always this one button, before and after the list's code arrives, so focus
 * and a press on it are never lost; it carries the list's popup semantics itself.
 */
export function ChipFace({
  label,
  button,
  open,
  popup,
  onToggle,
  onClear,
}: {
  label: string;
  button: RefObject<HTMLButtonElement | null>;
  open: boolean;
  /** The list's id, named while it is open. */
  popup: string;
  onToggle(): void;
  onClear(): void;
}) {
  return (
    <div className="inline-flex h-8 max-w-full min-w-0 items-center gap-0.5 rounded-md border border-sidebar-border bg-background/50 pr-1 pl-1">
      <button
        ref={button}
        type="button"
        aria-label={`Show ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popup : undefined}
        onClick={onToggle}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1 text-ui leading-4 text-foreground focus-ring hover:text-foreground aria-expanded:text-foreground"
      >
        <ChatTeardropTextIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
        <span className="truncate tabular-nums">{label}</span>
      </button>
      <IconButton
        icon={XIcon}
        label="Remove all annotations"
        size="sm"
        tooltip={false}
        onClick={onClear}
      />
    </div>
  );
}
