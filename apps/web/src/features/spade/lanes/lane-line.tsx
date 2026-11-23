import { spadeQuietLine, type SpadeQuiet } from "@ace/ui-core/spade-chat";
import { Button } from "@/components/ui/button.tsx";
import { QuietLine } from "../spade-quiet-line.tsx";
import { laneById, laneDetail, laneLive } from "./lanes-fixture.ts";
import { setLanesPlace } from "./lanes-place.ts";

type LaneQuiet = Extract<SpadeQuiet, { kind: "lane" }>;

/**
 * Prototype (ADR 0217 §7): a lane's quiet line in main's chat. Where the lane started, the line
 * carries its step and count while it runs, and reads as the record once it ends. Every line opens
 * the lane; a failed task's report offers Try again.
 */
export function LaneQuietLine(props: { quiet: LaneQuiet }) {
  const { quiet } = props;
  const lane = laneById(quiet.lane);
  const line = spadeQuietLine(quiet);
  const live = quiet.event === "started" && lane && laneLive(lane);
  const shown = live
    ? {
        ...line,
        words: [...line.words, { text: ` · ${laneDetail(lane)}` }],
        label: `${line.label} · ${laneDetail(lane)}`,
      }
    : line;
  const open = () => setLanesPlace({ lane: quiet.lane, popover: false });
  return (
    <div className="flex min-w-0 items-center gap-1">
      <QuietLine line={shown} onOpen={open} />
      {quiet.event === "failed" && (
        <Button variant="ghost" size="sm" className="h-7 px-1.5 text-ui">
          Try again
        </Button>
      )}
    </div>
  );
}
