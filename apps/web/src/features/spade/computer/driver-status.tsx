import { coworkLine } from "@ace/ui-core/cowork";
import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { Button } from "@/components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeFace } from "../spade-face.tsx";
import type { BotComputerState } from "./use-bot-computer.ts";

/**
 * Who has the bot's computer, in one sentence, with the one thing to do about it. In cowork both
 * use it: "Spade is working here" or "Spade is waiting for you" (it yields to the person's
 * input), with Take over, which pauses the bot, as the secondary action. In exclusive mode: "You
 * have it. Spade is paused." or "Stopping Spade…", with Hand back. Words never cut mid-word: in a
 * narrow container (`@container` on the parent) they shorten to the face, "Stopping…" or "You".
 */
export function DriverStatus(props: {
  bot: { name: string; avatar: SpadeAvatar };
  state: BotComputerState;
  /** Fills its row (the phone's bottom bar). */
  fill?: boolean;
  /** Always the short words (the tile, beside its own heading), with no container to measure. */
  brief?: boolean;
}) {
  const { state, bot } = props;
  const person = state.paused || state.stopping;
  // The whole sentence is always read; it shows only where there is room for it.
  const long = props.brief ? "sr-only" : "sr-only whitespace-nowrap @2xl:not-sr-only";
  const short = props.brief ? "whitespace-nowrap" : "whitespace-nowrap @2xl:hidden";
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
              <span className="text-foreground">{coworkLine("yours", bot.name)}.</span>{" "}
              {`${bot.name} is paused.`}
            </span>
            <span aria-hidden className={cn(short, "text-foreground")}>
              {props.brief ? coworkLine("yours", bot.name) : "You"}
            </span>
          </>
        ) : (
          <>
            <SpadeFace
              avatar={bot.avatar}
              size={20}
              state={state.status === "working" ? "working" : "idle"}
            />
            <span className={long}>{coworkLine(state.status, bot.name)}</span>
          </>
        )}
      </p>
      {person ? (
        <Button
          size="sm"
          variant="primary"
          disabled={state.pending !== undefined}
          onClick={state.handBack}
          className="shrink-0"
        >
          Hand back
        </Button>
      ) : (
        <TakeOver bot={bot.name} state={state} />
      )}
    </div>
  );
}

/** Take over, the secondary action in cowork, saying where it is offered what it does. */
export function TakeOver(props: { bot: string; state: BotComputerState; variant?: "ghost" }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant={props.variant ?? "secondary"}
            disabled={props.state.pending !== undefined}
            onClick={props.state.takeOver}
            className="shrink-0"
          />
        }
      >
        Take over
      </TooltipTrigger>
      <TooltipContent>{`Pauses ${props.bot} until you hand back`}</TooltipContent>
    </Tooltip>
  );
}
