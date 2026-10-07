import { ArrowUpIcon, ClockIcon, StopIcon } from "@phosphor-icons/react";
import { Spinner } from "@/components/ui/spinner.tsx";
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

/**
 * What Enter does now, and what ⌘↵ does instead while the agent works. A provider that can't
 * steer only queues, so ⌘↵ isn't offered (UX audit SY-14).
 */
function hint(mode: Exclude<PrimaryMode, "stop">, canSteer: boolean): string {
  const mod = formatKeys("mod+enter");
  if (mode === "steer") return `Steer into the running turn · ${mod} queues it instead`;
  if (mode === "queue")
    return canSteer
      ? `Queue · sends when the agent is free · ${mod} steers it in now`
      : "Queue · sends when the agent is free";
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
  /** The provider can steer a running turn; otherwise follow-ups only queue. */
  canSteer?: boolean | undefined;
  /** A Stop is on its way: "Stopping…" until the turn ends. */
  stopping?: boolean | undefined;
  onSend(): void;
  onStop(): void;
}) {
  if (props.mode === "stop")
    return props.stopping ? (
      <Tip label="Stopping… the agent stops at its next safe point" side="top">
        <button
          type="button"
          aria-label="Stopping…"
          aria-disabled
          className={cn(iconControl, "cursor-default bg-foreground/10 text-muted-foreground")}
        >
          <Spinner />
        </button>
      </Tip>
    ) : (
      <Tip label="Stop the agent and its subagents" side="top">
        <button
          type="button"
          aria-label="Stop the agent"
          onClick={props.onStop}
          className={cn(
            iconControl,
            "bg-foreground text-background hover:bg-foreground/85 hover:text-background",
          )}
        >
          <StopIcon aria-hidden size={12} weight="fill" />
        </button>
      </Tip>
    );
  const mode = props.mode;
  const blocked = props.blocked;
  return (
    <Tip
      label={blocked ?? hint(mode, props.canSteer !== false)}
      {...(blocked ? {} : { keys: "enter" })}
      side="top"
    >
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
            ? "cursor-default bg-foreground/10 text-subtle-foreground hover:bg-foreground/10 hover:text-subtle-foreground active:scale-100"
            : "bg-foreground text-background hover:bg-foreground/85 hover:text-background",
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
