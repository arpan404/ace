import { ArrowUpIcon, ClockIcon, StopIcon } from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { iconControl } from "./composer-styles.ts";

export type PrimaryMode = "send" | "queue" | "steer" | "stop";

const labels: Record<Exclude<PrimaryMode, "stop">, string> = {
  send: "Send",
  queue: "Queue message",
  steer: "Steer message",
};

/** What Enter does now, and what ⌘↵ does instead while the agent works. */
function hint(mode: Exclude<PrimaryMode, "stop">): string {
  const mod = formatKeys("mod+enter");
  if (mode === "steer") return `Steer into the running turn · ${mod} queues it instead`;
  if (mode === "queue") return `Queue · sends when the agent is free · ${mod} steers it in now`;
  return "Send";
}

/**
 * The composer's one primary action, always in the same place: Send, Queue or Steer for a draft
 * (by the daemon's follow-up setting while the agent works), Stop when the agent works and the
 * composer is empty. A draft never turns into Stop. Unavailable, it stays focusable and its
 * tooltip says why.
 */
export function PrimaryAction(props: {
  mode: PrimaryMode;
  /** Why the draft can't go yet; undefined when it can. */
  blocked: string | undefined;
  /** Nothing can be sent here at all (not just yet): drawn at the disabled controls' strength. */
  off?: boolean | undefined;
  /** The element that says why, while `off`. */
  describedBy?: string | undefined;
  onSend(): void;
  onStop(): void;
}) {
  if (props.mode === "stop")
    return (
      <Tip label="Stop the agent and its subagents" side="top">
        <button
          type="button"
          aria-label="Stop the agent"
          onClick={props.onStop}
          className={cn(iconControl, "bg-secondary text-foreground hover:bg-accent")}
        >
          <StopIcon aria-hidden size={14} weight="fill" />
        </button>
      </Tip>
    );
  const mode = props.mode;
  const blocked = props.blocked;
  return (
    <Tip label={blocked ?? hint(mode)} {...(blocked ? {} : { keys: "enter" })} side="top">
      <button
        type="button"
        aria-label={labels[mode]}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={props.off ? props.describedBy : undefined}
        onClick={() => {
          if (!blocked) props.onSend();
        }}
        className={cn(
          iconControl,
          blocked
            ? "cursor-default bg-secondary text-subtle-foreground hover:bg-secondary hover:text-subtle-foreground"
            : "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground active:scale-95",
          props.off && "opacity-40",
        )}
      >
        {mode === "queue" ? (
          <ClockIcon aria-hidden size={16} weight="bold" />
        ) : (
          <ArrowUpIcon aria-hidden size={16} weight="bold" />
        )}
      </button>
    </Tip>
  );
}
