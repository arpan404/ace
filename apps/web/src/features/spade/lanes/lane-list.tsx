import {
  spadeLaneCost,
  spadeLaneDetail,
  spadeLaneLive,
  spadeLaneRowState,
  spadeLanesNeedYou,
  spadeLanesPillWords,
  type SpadeAvatar,
  type SpadeLane,
} from "@ace/ui-core/spade-chat";
import type { SubagentState } from "@ace/ui-core";
import { useState } from "react";
import { StatusIcon } from "@/components/status-icons.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { AgentRowContents, agentRowStyles, SubagentElapsed } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useLive } from "@/lib/live-connection.ts";
import { SpadeFace } from "../spade-face.tsx";
import { conversationPillShape } from "../spade-pill.tsx";

/*
 * The tasks pill and its task list (ADR 0217 §7). The pill sits beside the bot's at the top of
 * its conversation and names the tasks that haven't ended ("3 tasks · 1 needs you"). It opens the
 * list as a popover on the solid surface ace's content popovers use: one flat list in Spade's
 * order, each row ace's agent row with the bot's face, the task's title, its cost quietly beside
 * it, its state in words with how long it has run, and its step and count, or its report.
 */

const pose: Record<SubagentState, "working" | "needs-you" | "blocked" | "done" | "idle"> = {
  working: "working",
  human: "needs-you",
  waiting: "idle",
  queued: "idle",
  unresponsive: "blocked",
  failed: "blocked",
  cancelled: "idle",
  done: "done",
};

function LaneRow(props: {
  lane: SpadeLane;
  avatar: SpadeAvatar;
  onOpen(): void;
  onStop?: (() => Promise<boolean>) | undefined;
}) {
  const { lane } = props;
  const live = useLive(true);
  const running = spadeLaneLive(lane);
  const state = spadeLaneRowState(lane);
  const detail = spadeLaneDetail(lane);
  const [stopping, setStopping] = useState(false);
  const stop = props.onStop;
  return (
    <li data-subagent-state={state} className="group/task relative">
      <button
        type="button"
        aria-label={`Open ${lane.title}`}
        className={agentRowStyles.box}
        onClick={props.onOpen}
      >
        <AgentRowContents
          mark={{}}
          lead={<SpadeFace avatar={props.avatar} size={16} state={pose[state]} />}
          name={lane.title}
          meta={spadeLaneCost(lane)}
          state={state}
          live={live}
          elapsed={
            lane.startedMs > 0 && (
              <SubagentElapsed
                startedAt={lane.startedMs}
                endedAt={lane.endedMs}
                running={running && lane.state !== "queued"}
                fresh
              />
            )
          }
          detail={detail}
          detailKind={
            state === "human"
              ? "human"
              : state === "failed"
                ? "failed"
                : running
                  ? "live"
                  : "result"
          }
        />
      </button>
      {/* Stop, in words, over its state while the pointer or focus is on the row. */}
      {stop && running && (
        <Button
          size="xs"
          variant="ghost"
          tone="danger"
          aria-label={`Stop ${lane.title}`}
          disabled={stopping}
          className="absolute top-1.5 right-0 rounded-full bg-popover opacity-0 transition-opacity group-focus-within/task:opacity-100 group-hover/task:opacity-100 pointer-coarse:opacity-100"
          onClick={() => {
            setStopping(true);
            void stop().then(() => setStopping(false));
          }}
        >
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      )}
    </li>
  );
}

/** The rows, in Spade's order: needs you, running, ended, queued. */
export function LaneRows(props: {
  lanes: readonly SpadeLane[];
  avatar: SpadeAvatar;
  onOpen(lane: string): void;
  /** Stops one task alone; resolves false when it didn't go through. */
  onStop?: ((lane: string) => Promise<boolean>) | undefined;
}) {
  return (
    <ul aria-label="Tasks" className="flex flex-col gap-0.5">
      {props.lanes.map((lane) => (
        <LaneRow
          key={lane.task}
          lane={lane}
          avatar={props.avatar}
          onOpen={() => props.onOpen(lane.task)}
          onStop={props.onStop && (() => props.onStop?.(lane.task) ?? Promise.resolve(false))}
        />
      ))}
    </ul>
  );
}

/**
 * The pill beside the bot's: "3 tasks · 1 needs you", led by its still mark in the state that
 * matters most. It opens the task list under it; a row opens that task and closes the list.
 */
export function LanesPill(props: {
  lanes: readonly SpadeLane[];
  avatar: SpadeAvatar;
  onOpen(lane: string): void;
  /** More ended tasks may be left out: a plain row asks for them. */
  onOlder?: (() => void) | undefined;
  onStop?: ((lane: string) => Promise<boolean>) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const needs = spadeLanesNeedYou(props.lanes);
  const running = props.lanes.some(spadeLaneLive);
  const words = spadeLanesPillWords(props.lanes);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Tasks: ${words}`}
        className={cn(conversationPillShape, "pl-3.5")}
      >
        <StatusIcon
          kind={needs ? "approve" : running ? "working" : "done"}
          tone={needs ? "needs-you" : running ? "working" : "finished"}
          size={16}
        />
        <span className="min-w-0 truncate">{words}</span>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        sideOffset={8}
        aria-label="Tasks"
        surface="solid"
        className="max-h-[min(var(--available-height),32rem)] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain p-2"
      >
        <LaneRows
          lanes={props.lanes}
          avatar={props.avatar}
          onOpen={(lane) => {
            setOpen(false);
            props.onOpen(lane);
          }}
          onStop={props.onStop}
        />
        {props.onOlder && (
          <button
            type="button"
            onClick={props.onOlder}
            className={cn(agentRowStyles.box, "text-muted-foreground hover:text-foreground")}
          >
            Show older tasks
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
