import {
  spadeLaneLive,
  spadeLaneStep,
  spadeQuietLine,
  type SpadeQuiet,
  type SpadeQuietLine,
} from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { QuietLine } from "../spade-quiet-line.tsx";
import { useLanesHere } from "./lanes-context.ts";

type LaneQuiet = Extract<SpadeQuiet, { kind: "lane" }>;

/**
 * A task's quiet line in main's chat (ADR 0217 §7), in Spade's words. Where the task started, the
 * line carries its step and count while it runs ("· 2 of 5 · Drafting the email to Dana") and is
 * the record once it ends. Every line opens the task; one that stopped early offers Try again.
 */
export function LaneQuietLine(props: { quiet: LaneQuiet }) {
  const { quiet } = props;
  const here = useLanesHere();
  const lane = here?.lanes.find((each) => each.task === quiet.lane);
  // The title as Spade has it now, which a later naming may have changed.
  const line = spadeQuietLine(lane ? { ...quiet, title: lane.title } : quiet);
  const starts = quiet.event === "started" || quiet.event === "queued";
  const step = starts && lane && spadeLaneLive(lane) ? spadeLaneStep(lane) : undefined;
  const shown: SpadeQuietLine = step
    ? { ...line, words: [...line.words, { text: ` · ${step}` }], label: `${line.label} · ${step}` }
    : line;
  const [trying, setTrying] = useState(false);
  // Try again only while it is still the failure: once it runs again, the line is the record.
  const reply = quiet.event === "failed" && lane?.state === "failed" ? quiet.reply : undefined;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <QuietLine line={shown} onOpen={here ? () => here.open(quiet.lane) : undefined} />
      {here && reply && (
        <Button
          variant="ghost"
          size="sm"
          disabled={trying}
          className="h-7 shrink-0 rounded-full px-2 text-ui"
          onClick={() => {
            setTrying(true);
            void here.retry(quiet.lane, reply).then(() => setTrying(false));
          }}
        >
          {trying ? "Trying again…" : "Try again"}
        </Button>
      )}
    </div>
  );
}
