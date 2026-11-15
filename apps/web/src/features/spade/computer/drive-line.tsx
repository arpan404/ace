import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { Button } from "@/components/ui/button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { SpadeFace } from "../spade-face.tsx";
import { rowPill } from "../spade-profile-parts.tsx";
import type { BotComputerState } from "./use-bot-computer.ts";

/**
 * Who has the computer, under what it shows, only while someone does: the bot's face, moving,
 * and "Github watcher is using the browser" with Take over, while it drives; "You have the
 * browser" with Hand back once the person took over; "Stopping…" while its work ends. Nothing
 * while neither uses it.
 */
export function DriveLine(props: {
  bot: { name: string; avatar: SpadeAvatar };
  state: BotComputerState;
  /** "browser", "screen", "terminal": what it is using, in the sentence. */
  what: string;
}) {
  const { state, bot } = props;
  const person = state.paused || state.stopping;
  if (!person && state.status !== "working" && state.status !== "waiting") return null;
  return (
    <div
      role="status"
      className="mt-3 flex min-h-12 items-center gap-2.5 rounded-full bg-surface-1 py-2 pr-2 pl-3 text-ui text-foreground"
    >
      {!person && <SpadeFace avatar={bot.avatar} size={24} state="working" />}
      <span className="min-w-0 flex-1 truncate">
        {state.stopping
          ? `Stopping ${bot.name}…`
          : person
            ? `You have the ${props.what}`
            : state.status === "waiting"
              ? `${bot.name} is waiting for you`
              : `${bot.name} is using the ${props.what}`}
      </span>
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
