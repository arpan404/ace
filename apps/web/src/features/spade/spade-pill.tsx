import { botFaceStateOf } from "@ace/ui-core/bot-face";
import type { ReactNode } from "react";
import { part } from "@/lib/suit-part.ts";
import { SpadeFace } from "./spade-face.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** The pill's capsule, in the composer's glass. */
export const conversationPillShape =
  "ace-glass-dock flex h-10 min-w-0 items-center gap-2 rounded-full border border-input pr-4 pl-1.5 text-ui font-medium text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover";

/** Where the pill floats: at the top centre of a conversation. */
const conversationPillPlace =
  "absolute top-3 left-1/2 z-10 max-w-[calc(100%-2rem)] -translate-x-1/2";

/** One pill on its own at the top centre of a conversation. */
export const conversationPill = `${conversationPillPlace} ${conversationPillShape}`;

/**
 * The pills at the top centre of a bot's conversation, side by side: the bot's, and beside it the
 * tasks pill while the bot has tasks (ADR 0217 §7).
 */
export function PillRow(props: { children: ReactNode }) {
  return <div className={`${conversationPillPlace} flex items-center gap-2`}>{props.children}</div>;
}

/**
 * The scroll edge under the pill: the transcript fades into the page behind it, so words never
 * run under the pill (the platform's scroll-edge effect, not a bar).
 */
export function PillEdge() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-16 bg-linear-to-b from-background from-40% to-transparent"
    />
  );
}

/** The pill's face, in px (`--spade-pill-face`). */
const face = 28;

/**
 * The pill floating at the top centre of a bot's conversation, over the transcript as the
 * composer floats under it, in the composer's glass: the bot's face (moving while it works) and
 * its name, its machine only when that isn't this one, and "Full access" when the bot is in it.
 * It opens the bot's profile.
 */
export function ConversationPill(props: { bot: RosterBot; onOpen(): void }) {
  const { bot } = props;
  const state = bot.away || bot.unavailable ? "idle" : botFaceStateOf(bot);
  const elsewhere = !bot.machine.primary;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-label={`${bot.name}${elsewhere ? ` on ${bot.machine.name}` : ""}${bot.fullAccess ? ", Full access" : ""}: open its profile`}
      {...part("header-title", undefined, "spade-pill")}
      className={conversationPillShape}
    >
      <SpadeFace avatar={bot.avatar} size={face} state={state} />
      <span className="min-w-0 truncate">{bot.name}</span>
      {elsewhere && (
        <span className="shrink-0 font-normal text-subtle-foreground">on {bot.machine.name}</span>
      )}
      {/* Quietly: it decides without the reviewer (ADR 0163, amendment 2). */}
      {bot.fullAccess && (
        <span className="shrink-0 font-normal text-subtle-foreground">Full access</span>
      )}
    </button>
  );
}

/**
 * An open task's pill (ADR 0217 §7): the bot's face, the task's title, and the bot named quietly
 * after it. It goes back to the bot's main conversation.
 */
export function TaskPill(props: { bot: RosterBot; title: string; onBack(): void }) {
  const { bot } = props;
  return (
    <button
      type="button"
      onClick={props.onBack}
      aria-label={`${props.title}, a task of ${bot.name}: back to ${bot.name}`}
      {...part("header-title", undefined, "spade-pill")}
      className={conversationPill}
    >
      <SpadeFace
        avatar={bot.avatar}
        size={face}
        state={bot.away || bot.unavailable ? "idle" : botFaceStateOf(bot)}
      />
      <span className="min-w-0 truncate">{props.title}</span>
      <span className="shrink-0 font-normal text-subtle-foreground">Task of {bot.name}</span>
    </button>
  );
}
