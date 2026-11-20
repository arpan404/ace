import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { fault } from "./spade-profile-actions.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { agentsKey } from "./use-spade-roster.ts";
import { actOnBot, runningKey } from "./use-spade-running.ts";

/*
 * An archived bot's line under its name (ADR 0197): Undo kept it and stopped it, its routines
 * paused. Unarchive brings it back: the routines that were on come back on, nothing was deleted.
 */
export function ProfileArchived(props: { bot: { id: string; name: string } }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const unarchive = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await actOnBot(client, props.bot.id, "unarchive");
      await Promise.all([
        cache.invalidateQueries({ queryKey: agentsKey }),
        cache.invalidateQueries({ queryKey: runningKey }),
      ]);
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="note" aria-label={`${props.bot.name} is archived`} className="-mt-1 flex flex-col">
      <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-ui text-muted-foreground">
        Archived: kept and stopped, its routines paused
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-1.5 text-ui"
          disabled={busy}
          onClick={() => void unarchive()}
        >
          Unarchive
        </Button>
      </p>
      {problem && (
        <p className="text-ui text-(--tone-text)" data-tone="failed">
          {problem}
        </p>
      )}
    </div>
  );
}
