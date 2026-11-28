import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { Button } from "@/components/ui/button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { SpadeFace } from "../spade-face.tsx";
import { rowPill } from "../spade-profile-parts.tsx";
import type { BotComputerState } from "./use-bot-computer.ts";

/**
 * Who has the computer, under what it shows: the bot's face, moving, and "Github watcher is
 * using the browser" with Take over, only while it drives; "You have the browser" with Hand back
 * once the person took over; "Stopping…" while its work ends. While neither uses it, one quiet
 * sentence says so, with no face and no button.
 */

/** Who has the computer, in words: the sentence, whether the person has it, whether the bot does. */
export function driveWords(state: BotComputerState, botName: string, what: string) {
  const person = state.paused || state.stopping;
  const busy = state.status === "working" || state.status === "waiting";
  if (!person && !busy)
    return { person, busy: false, text: `${botName} isn't using the ${what} now.` };
  const text = state.stopping
    ? `Stopping ${botName}…`
    : person
      ? `You have the ${what}`
      : state.status === "waiting"
        ? `${botName} is waiting for you`
        : `${botName} is using the ${what}`;
  return { person, busy: true, text };
}

export function DriveLine(props: {
  bot: { name: string; avatar: SpadeAvatar };
  state: BotComputerState;
  /** "browser", "screen", "terminal": what it is using, in the sentence. */
  what: string;
}) {
  const { state, bot } = props;
  const words = driveWords(state, bot.name, props.what);
  const person = words.person;
  if (!words.busy) return <p className="mx-1 mt-3 text-ui text-muted-foreground">{words.text}</p>;
  return (
    <div
      role="status"
      className="mt-3 flex min-h-12 items-center gap-2.5 rounded-full bg-surface-1 py-2 pr-2 pl-3 text-ui text-foreground"
    >
      {!person && <SpadeFace avatar={bot.avatar} size={24} state="working" />}
      <span className="min-w-0 flex-1 truncate">{words.text}</span>
      {person ? (
        <Button
          size="sm"
          variant="secondary"
          className={rowPill}
          disabled={state.pending !== undefined}
          onClick={state.handBack}
        >
          Hand back
        </Button>
      ) : (
        <Tip label={`Pauses ${bot.name} until you hand back`}>
          <Button
            size="sm"
            variant="secondary"
            className={rowPill}
            disabled={state.pending !== undefined}
            onClick={state.takeOver}
          >
            Take over
          </Button>
        </Tip>
      )}
    </div>
  );
}
