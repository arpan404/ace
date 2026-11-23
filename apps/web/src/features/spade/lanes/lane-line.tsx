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
import { messageAttribute, useSpadeReplies } from "../spade-chat-replies.tsx";
import { useLanesHere } from "./lanes-context.ts";

type LaneQuiet = Extract<SpadeQuiet, { kind: "lane" }>;

/**
 * A task's quiet line in main's chat (ADR 0217 §7), in Spade's words. Where the task started, the
 * line carries its step and count while it runs ("· 2 of 5 · Drafting the email to Dana") and is
 * the record once it ends. Every line opens the task; one that stopped early offers Try again.
 */
export function LaneQuietLine(props: {
  quiet: LaneQuiet;
  /** The line's message id: replying to it sends the person's words to the task (ADR 0217 §2). */
  id?: string | undefined;
}) {
  const { quiet } = props;
  const here = useLanesHere();
  const replies = useSpadeReplies();
  const lane = here?.lanes.find((each) => each.task === quiet.lane);
  // The title as it stands now, which a later naming may have changed.
  const line = spadeQuietLine(
    here ? { ...quiet, title: here.titleOf(quiet.lane, quiet.title) } : quiet,
  );
  const starts = quiet.event === "started" || quiet.event === "queued";
  const step = starts && lane && spadeLaneLive(lane) ? spadeLaneStep(lane) : undefined;
  const shown: SpadeQuietLine = step
    ? { ...line, words: [...line.words, { text: ` · ${step}` }], label: `${line.label} · ${step}` }
    : line;
  const [trying, setTrying] = useState(false);
  // Try again only while it is still the failure: once it runs again, the line is the record.
  const reply = quiet.event === "failed" && lane?.state === "failed" ? quiet.reply : undefined;
  return (
    <div
      className="group/lane flex min-w-0 items-center gap-1"
      {...(props.id ? { [messageAttribute]: props.id } : {})}
    >
      <QuietLine line={shown} onOpen={here ? () => here.open(quiet.lane) : undefined} />
      {here && replies && props.id && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Reply to ${here.titleOf(quiet.lane, quiet.title)}`}
          className="h-7 shrink-0 rounded-full px-2 text-ui opacity-0 transition-opacity group-hover/lane:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          onClick={() => {
            const id = props.id;
            if (id) replies.reply({ id, who: { kind: "bot" }, text: shown.label });
          }}
        >
          Reply
        </Button>
      )}
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

type OverlapQuiet = Extract<SpadeQuiet, { kind: "lanes-overlapped" }>;

/**
 * Two running tasks changed one file (ADR 0217 §3): "Fix the March invoice and Draft the
 * quarterly note both changed totals.xlsx". A note, never a lock; it opens the first task.
 */
export function OverlapQuietLine(props: { quiet: OverlapQuiet }) {
  const { quiet } = props;
  const here = useLanesHere();
  const line = spadeQuietLine(
    here
      ? {
          ...quiet,
          title: here.titleOf(quiet.lane, quiet.title),
          otherTitle: here.titleOf(quiet.other, quiet.otherTitle),
        }
      : quiet,
  );
  return <QuietLine line={line} onOpen={here ? () => here.open(quiet.lane) : undefined} />;
}
