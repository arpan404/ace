import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeFace } from "../spade-face.tsx";
import type { BotComputerState } from "./use-bot-computer.ts";

/**
 * Who drives the bot's computer, with the one thing to do about it: "Spade is driving · Take
 * over", "Stopping Spade… · Hand back" while the bot's work ends, or "You're driving. Spade is
 * paused. · Hand back". Words never cut mid-word: in a narrow container (`@container` on the
 * parent) they shorten to the face, "Stopping…" or "You".
 */
export function DriverStatus(props: {
  bot: { name: string; avatar: SpadeAvatar };
  state: BotComputerState;
  /** Fills its row (the phone's bottom bar, the tile's side). */
  fill?: boolean;
}) {
  const { state, bot } = props;
  const person = state.paused || state.stopping;
  // The whole sentence is always read; it shows only where there is room for it.
  const long = "sr-only whitespace-nowrap @2xl:not-sr-only";
  const short = "whitespace-nowrap @2xl:hidden";
  return (
    <div role="status" className={cn("flex min-w-0 items-center gap-2", props.fill && "flex-1")}>
      <p
        className={cn(
          "flex min-w-0 items-center gap-2 text-ui text-muted-foreground",
          props.fill && "flex-1",
        )}
      >
        {state.stopping ? (
          <>
            <span className={long}>{`Stopping ${bot.name}…`}</span>
            <span aria-hidden className={short}>
              Stopping…
            </span>
          </>
        ) : person ? (
          <>
            <span className={long}>
              <span className="text-foreground">You're driving.</span> {`${bot.name} is paused.`}
            </span>
            <span aria-hidden className={cn(short, "text-foreground")}>
              You
            </span>
          </>
        ) : (
          <>
            <SpadeFace avatar={bot.avatar} size={20} state="working" />
            <span className={long}>{`${bot.name} is driving`}</span>
          </>
        )}
      </p>
      <Button
        size="sm"
        variant={person ? "primary" : "secondary"}
        disabled={state.pending !== undefined}
        onClick={person ? state.handBack : state.takeOver}
        className="shrink-0"
      >
        {person ? "Hand back" : "Take over"}
      </Button>
    </div>
  );
}
