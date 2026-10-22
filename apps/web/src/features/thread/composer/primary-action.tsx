import { ArrowBendUpRightIcon, ArrowUpIcon, StopIcon, QueueIcon } from "@phosphor-icons/react";
import { memo } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { iconControl } from "./composer-styles.ts";

export type PrimaryMode = "send" | "queue" | "steer";

const labels: Record<PrimaryMode, string> = {
  send: "Send",
  queue: "Queue message",
  steer: "Steer message",
};

/** Queue and Steer read apart from Send, in the queue strip's own glyphs. */
const icons = {
  send: ArrowUpIcon,
  queue: QueueIcon,
  steer: ArrowBendUpRightIcon,
};

/**
 * What Enter does now, and what the other send key (⌘↵ unless rebound) does instead: the other
 * follow-up while the agent works, or `otherHint` where it means something else. A provider
 * that can't steer only queues, so the other follow-up isn't offered (UX audit SY-14).
 */
function hint(
  mode: PrimaryMode,
  canSteer: boolean,
  otherKeys: string,
  otherHint: string | undefined,
): string {
  const other = formatKeys(otherKeys);
  if (mode === "steer") return `Steer into the running turn · ${other} queues it instead`;
  if (mode === "queue")
    return canSteer
      ? `Queue for after this turn · ${other} steers it now`
      : "Queue for after this turn";
  return otherHint ? `Send · ${other} ${otherHint}` : "Send";
}

/**
 * The composer's send control, always in the same place: Send, or Queue or Steer while the
 * agent works (by the daemon's follow-up setting). Unavailable, it stays focusable and its
 * tooltip says why. An empty busy draft shows Stop in this same slot.
 */
export const PrimaryAction = memo(function PrimaryAction(props: {
  mode: PrimaryMode;
  /** Why the draft can't go yet; undefined when it can. */
  blocked: string | undefined;
  /** Nothing can be sent here at all (not just yet): drawn at the disabled controls' strength. */
  off?: boolean | undefined;
  /** The element that says why, while `off`. */
  describedBy?: string | undefined;
  /** The provider can steer a running turn; otherwise follow-ups only queue. */
  canSteer?: boolean | undefined;
  /** The other send key, as bound now. */
  otherKeys: string;
  /** What it does when that isn't the other follow-up (New thread). */
  otherHint?: string | undefined;
  onSend(): void;
}) {
  const { mode, blocked } = props;
  const Glyph = icons[mode];
  return (
    <Tip
      label={blocked ?? hint(mode, props.canSteer !== false, props.otherKeys, props.otherHint)}
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
            : "bg-tint text-tint-foreground shadow-none hover:bg-tint/85 hover:text-tint-foreground focus-visible:bg-tint/85 focus-visible:text-tint-foreground",
          props.off && "opacity-40",
        )}
      >
        <Glyph aria-hidden size={16} weight="bold" />
      </button>
    </Tip>
  );
});

/**
 * Stop occupies the primary slot while the agent works and the draft is empty.
 * "Stopping…" until the turn ends; the stop shortcut also works with a draft.
 */
export const StopAction = memo(function StopAction(props: { stopping: boolean; onStop(): void }) {
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
    <Tip label="Stop the agent and its subagents" keys="escape escape" resolve={false} side="top">
      <button
        type="button"
        aria-label="Stop the agent"
        onClick={props.onStop}
        className={cn(
          iconControl,
          "bg-danger text-danger-foreground hover:bg-danger-hover hover:text-danger-foreground focus-visible:bg-danger-hover focus-visible:text-danger-foreground active:bg-danger-pressed",
        )}
      >
        <StopIcon aria-hidden size={12} weight="fill" />
      </button>
    </Tip>
  );
});
