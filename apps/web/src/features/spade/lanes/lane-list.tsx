import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import type { SubagentState } from "@ace/ui-core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { StatusIcon } from "@/components/status-icons.tsx";
import { AgentRowContents, agentRowStyles, SubagentElapsed } from "@/features/thread/index.ts";
import { useLive } from "@/lib/live-connection.ts";
import { SpadeFace } from "../spade-face.tsx";
import { conversationPillShape } from "../spade-pill.tsx";
import {
  laneCost,
  laneDetail,
  laneLive,
  lanesInOrder,
  lanesPillWords,
  type LaneFixture,
  type LaneState,
} from "./lanes-fixture.ts";
import { setLanesPlace } from "./lanes-place.ts";

/*
 * Prototype (ADR 0217 §7): the task list, drawn with ace's own agent row. Each row: the bot's
 * face (a lane is the bot at work), the task's title, its cost quietly beside it, its state in
 * words with how long it has run, and one quieter line: the step and count, or the report.
 */

const rowState: Record<LaneState, SubagentState> = {
  working: "working",
  human: "human",
  done: "done",
  failed: "failed",
  queued: "queued",
};

const facePose = (state: LaneState) =>
  state === "working"
    ? ("working" as const)
    : state === "human"
      ? ("needs-you" as const)
      : state === "failed"
        ? ("blocked" as const)
        : state === "done"
          ? ("done" as const)
          : ("idle" as const);

const minutesAgo = (count: number) => Date.now() - count * 60_000;

function LaneRow(props: { lane: LaneFixture; avatar: SpadeAvatar; onOpen(): void }) {
  const { lane } = props;
  const live = useLive(true);
  const running = laneLive(lane);
  return (
    <li data-subagent-state={rowState[lane.state]} className="relative">
      <button
        type="button"
        aria-label={`Open ${lane.title}`}
        className={agentRowStyles.box}
        onClick={props.onOpen}
      >
        <AgentRowContents
          mark={{}}
          lead={<SpadeFace avatar={props.avatar} size={16} state={facePose(lane.state)} />}
          name={lane.title}
          meta={laneCost(lane.costMicros)}
          state={rowState[lane.state]}
          live={live}
          elapsed={
            <SubagentElapsed
              startedAt={minutesAgo(lane.startedMin)}
              endedAt={lane.endedMin === undefined ? undefined : minutesAgo(lane.endedMin)}
              running={running}
              fresh
            />
          }
          detail={laneDetail(lane)}
          detailKind={
            lane.state === "human"
              ? "human"
              : lane.state === "failed"
                ? "failed"
                : running
                  ? "live"
                  : "result"
          }
        />
      </button>
    </li>
  );
}

/** The rows, needs you first, then running, then finished, as one flat list. */
export function LaneRows(props: {
  lanes: readonly LaneFixture[];
  avatar: SpadeAvatar;
  onOpen?: () => void;
}) {
  return (
    <ul aria-label="Tasks" className="flex flex-col gap-0.5">
      {lanesInOrder(props.lanes).map((lane) => (
        <LaneRow
          key={lane.id}
          lane={lane}
          avatar={props.avatar}
          onOpen={() => {
            props.onOpen?.();
            setLanesPlace({ lane: lane.id, popover: false });
          }}
        />
      ))}
    </ul>
  );
}

/**
 * The pill beside the bot's: "3 tasks · 1 needs you", its still icon in the worst state's colour.
 * It opens the task list as a popover under it.
 */
export function LanesPill(props: {
  lanes: readonly LaneFixture[];
  avatar: SpadeAvatar;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const needs = props.lanes.some((lane) => lane.state === "human");
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger
        aria-label={`Tasks: ${lanesPillWords(props.lanes)}`}
        className={conversationPillShape + " pl-3.5"}
      >
        <StatusIcon
          kind={needs ? "approve" : "working"}
          tone={needs ? "needs-you" : "working"}
          size={16}
        />
        <span className="min-w-0 truncate">{lanesPillWords(props.lanes)}</span>
      </PopoverTrigger>
      <PopoverContent align="center" sideOffset={8} className="w-[min(30rem,calc(100vw-2rem))] p-2">
        <LaneRows
          lanes={props.lanes}
          avatar={props.avatar}
          onOpen={() => props.onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
