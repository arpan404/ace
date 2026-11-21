import { replayFailures, type SpadeReplay } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";

/*
 * What an update review says of the bot's kept runs replayed on the new version (ADR 0204 §2):
 * Spade's one sentence ("18 of 20 kept runs replay the same. 2 don't: see why."), and See why, a
 * text button that lists each run that didn't, with its first reason. Words, not chrome: no
 * icons, tints or badges. The review's own heading sits above it.
 */

export function ReplayLine(props: {
  replay: Pick<SpadeReplay, "summary" | "cases"> | undefined;
  /** The replay is still running. */
  pending?: boolean;
  /** Why it couldn't run. */
  error?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (props.pending)
    return <p className="text-ui text-muted-foreground">Replaying your kept runs…</p>;
  if (props.error)
    return (
      <p className="text-ui text-muted-foreground">Couldn't replay your kept runs: {props.error}</p>
    );
  const replay = props.replay;
  if (!replay || replay.cases.length === 0) return null;
  const failures = replayFailures(replay);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-ui text-foreground" role="status">
        {replay.summary}
      </p>
      {failures.length > 0 && (
        <div className="-ml-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? "Hide why" : "See why"}
          </Button>
        </div>
      )}
      {open && (
        <ul aria-label="Kept runs that differ" className="flex flex-col gap-1 text-ui">
          {failures.map((failure) => (
            <li key={`${failure.given}:${failure.why}`} className="text-muted-foreground">
              <span className="text-foreground">{failure.given}</span>: {failure.why}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
