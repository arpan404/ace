import { botFaceStateOf } from "@ace/ui-core/bot-face";
import { SpadeFace } from "./spade-face.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** The pill's face, in px (`--spade-pill-face`). */
const face = 28;

/**
 * The pill floating at the top centre of a bot's conversation, over the transcript as the
 * composer floats under it, in the composer's glass: the bot's face (moving while it works) and
 * its name, and its machine only when that isn't this one. It opens the bot's profile.
 */
export function ConversationPill(props: { bot: RosterBot; onOpen(): void }) {
  const { bot } = props;
  const state = bot.away || bot.unavailable ? "idle" : botFaceStateOf(bot);
  const elsewhere = !bot.machine.primary;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-label={`${bot.name}${elsewhere ? ` on ${bot.machine.name}` : ""}: open its profile`}
      className="ace-glass-dock absolute top-3 left-1/2 z-10 flex h-10 max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-input pr-4 pl-1.5 text-ui font-medium text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover"
    >
      <SpadeFace avatar={bot.avatar} size={face} state={state} />
      <span className="min-w-0 truncate">{bot.name}</span>
      {elsewhere && (
        <span className="shrink-0 font-normal text-subtle-foreground">on {bot.machine.name}</span>
      )}
    </button>
  );
}
