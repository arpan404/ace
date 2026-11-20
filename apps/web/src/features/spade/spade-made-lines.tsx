import { spadeTaskFirstLine, type SpadeBubble } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { undoMade } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { message } from "./spade-screen-parts.tsx";
import { agentsKey } from "./use-spade-roster.ts";

/*
 * What a bot made for the person, as its chat shows it (ADR 0161, amendment 1): one quiet line
 * where it happened, in words, with text buttons.
 */

type Made = Extract<SpadeBubble, { kind: "made" }>;
type ClubAdded = Extract<SpadeBubble, { kind: "club-added" }>;

const line = "ml-1.5 flex min-h-7 max-w-full min-w-0 flex-wrap items-center gap-x-2 text-ui";
const word = "h-7 px-1.5 text-ui";

/** How Undo left it, in words. */
const undoneWords = {
  removed: "Undone",
  archived: "Archived: it had already acted, so it's kept and stopped",
} as const;

/**
 * "Made a new bot: Research · Finds and summarises sources", with Open (its chat) and Undo, which
 * removes it, or archives it once it has acted. A bot no longer in the list offers neither.
 */
export function MadeLine(props: {
  item: Made;
  /** Whether the bot is still in the person's list. */
  listed: boolean;
  onOpen: ((id: string) => void) | undefined;
}) {
  const { item } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState<keyof typeof undoneWords>();
  const [problem, setProblem] = useState<string>();
  const undo = async () => {
    setUndoing(true);
    setProblem(undefined);
    try {
      setUndone(await undoMade(client, item.bot));
      await cache.invalidateQueries({ queryKey: agentsKey });
    } catch (error) {
      setProblem(message(error));
    } finally {
      setUndoing(false);
    }
  };
  const onOpen = props.onOpen;
  return (
    <div className="flex flex-col gap-1">
      <div role="note" aria-label={`Made a new bot: ${item.name}`} className={line}>
        <span className="min-w-0 text-muted-foreground">
          Made a new bot: <span className="font-medium text-foreground">{item.name}</span>
          {item.task && <span>{` · ${spadeTaskFirstLine(item.task, 90)}`}</span>}
        </span>
        {undone ? (
          <span className="text-muted-foreground">{undoneWords[undone]}</span>
        ) : (
          props.listed && (
            <>
              {onOpen && (
                <Button variant="ghost" size="sm" className={word} onClick={() => onOpen(item.bot)}>
                  Open
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className={word}
                disabled={undoing}
                onClick={() => void undo()}
              >
                {undoing ? "Undoing…" : "Undo"}
              </Button>
            </>
          )
        )}
      </div>
      {problem && (
        <p role="alert" className="ml-3 text-xs text-destructive">
          {`Couldn't undo it. ${problem}`}
        </p>
      )}
    </div>
  );
}

/** "Added Writer to Ops", where the bot did it. */
export function ClubAddedLine(props: { item: ClubAdded }) {
  return (
    <p role="note" className={cn(line, "text-muted-foreground")}>
      <span>
        Added <span className="font-medium text-foreground">{props.item.botName}</span> to{" "}
        <span className="font-medium text-foreground">{props.item.clubName}</span>
      </span>
    </p>
  );
}
