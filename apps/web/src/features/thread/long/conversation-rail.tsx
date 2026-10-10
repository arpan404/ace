import { useState, type KeyboardEvent, type ReactNode } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { cn } from "@/lib/cn.ts";

export interface ConversationMarker {
  id: string;
  label: string;
  ordinal: number;
}

/** A bounded outline of turn positions; transcript navigation and data stay with the caller. */
export function ConversationRail(props: {
  markers: readonly ConversationMarker[];
  currentId?: string;
  onJump(id: string): void;
  renderPreview(id: string): ReactNode;
  className?: string;
}) {
  const [focused, setFocused] = useState<string>();
  if (props.markers.length < 2) return null;
  const tabStop = props.markers.some((marker) => marker.id === focused)
    ? focused
    : (props.currentId ?? props.markers[0]?.id);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = props.markers.length - 1;
    const targets: Record<string, number> = {
      ArrowDown: Math.min(last, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: last,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const buttons = event.currentTarget
      .closest("nav")
      ?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[target]?.focus();
  };
  return (
    <nav
      aria-label="Conversation turns"
      className={cn("hidden w-7 flex-col items-center py-2 md:flex", props.className)}
    >
      {props.markers.map((marker, index) => (
        <ConversationTick
          key={marker.id}
          marker={marker}
          current={marker.id === props.currentId}
          tabIndex={marker.id === tabStop ? 0 : -1}
          onFocus={() => setFocused(marker.id)}
          onKeyDown={(event) => move(event, index)}
          onJump={() => props.onJump(marker.id)}
          renderPreview={() => props.renderPreview(marker.id)}
        />
      ))}
    </nav>
  );
}

function ConversationTick(props: {
  marker: ConversationMarker;
  current: boolean;
  tabIndex: number;
  onFocus(): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  onJump(): void;
  renderPreview(): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger
        render={
          <button
            type="button"
            aria-label={`Turn ${props.marker.ordinal}: ${props.marker.label}`}
            aria-current={props.current ? "location" : undefined}
            tabIndex={props.tabIndex}
            onFocus={props.onFocus}
            onKeyDown={props.onKeyDown}
            onClick={props.onJump}
          />
        }
        delay={180}
        closeDelay={100}
        className="group grid min-h-0 w-7 flex-1 place-items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-px rounded-full transition-[width,background-color] duration-150 group-hover:w-4 group-hover:bg-foreground/70 group-focus-visible:w-4 motion-reduce:transition-none",
            props.current ? "w-4 bg-foreground/80" : "w-2.5 bg-foreground/20",
          )}
        />
      </HoverCardTrigger>
      {open && (
        <HoverCardContent className="w-80 max-w-[calc(100vw-48px)] text-xs">
          <div className="mb-2 text-2xs font-medium text-subtle-foreground">
            Turn {props.marker.ordinal}
          </div>
          {props.renderPreview()}
        </HoverCardContent>
      )}
    </HoverCard>
  );
}
