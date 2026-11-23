import { spadeLaneCost, spadeLaneLive, type SpadeLane } from "@ace/ui-core/spade-chat";
import { XIcon } from "@ace/icons";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { pillButton, ProfileSection } from "../spade-profile-parts.tsx";
import { TaskGoal, WorkPlan } from "../spade-work-goal.tsx";
import { useLaneTask } from "./lanes-api.ts";

/*
 * An open task's goal and plan beside its transcript (ADR 0217 §7): the goal and plan as the
 * bot's Work tab shows its own, what the task has spent, and Stop task while it runs.
 */

export function LanePanel(props: {
  main: string;
  lane: SpadeLane;
  /** Changes whenever the task's chat moves: its goal and plan are read again then. */
  moved: number;
  stopping: boolean;
  onStop(): void;
  onClose(): void;
  onOpenFile(path: string): void;
}) {
  const { lane } = props;
  const task = useLaneTask(props.main, lane.task, props.moved).data;
  const cost = spadeLaneCost(lane);
  return (
    <section aria-label={`${lane.title}: goal and plan`} className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
          Goal and plan
        </h2>
        <IconButton icon={XIcon} label="Close goal and plan" tip="Close" onClick={props.onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-8">
        {task ? (
          <>
            <TaskGoal task={task} />
            <WorkPlan
              task={task}
              evidenceWords={(evidence) =>
                evidence.kind === "file"
                  ? evidence.path
                  : evidence.kind === "url"
                    ? evidence.url.replace(/^https?:\/\//, "")
                    : "A command's output"
              }
              onEvidence={(evidence) => {
                if (evidence.kind === "file") props.onOpenFile(evidence.path);
              }}
            />
          </>
        ) : (
          task === null && (
            <p className="px-1 py-2 text-ui text-muted-foreground">
              {lane.state === "queued"
                ? "It starts when one of the running tasks ends."
                : "No goal set yet."}
            </p>
          )
        )}
        {cost && (
          <ProfileSection label="Spent">
            <p className="px-3.5 py-2.5 text-ui text-foreground">
              {cost}
              <span className="text-muted-foreground"> on the tasks model</span>
            </p>
          </ProfileSection>
        )}
        {spadeLaneLive(lane) && (
          <div className="mt-6 -ml-3.5 flex">
            <Button
              variant="ghost"
              tone="danger"
              className={pillButton}
              disabled={props.stopping}
              onClick={props.onStop}
            >
              {props.stopping ? "Stopping…" : "Stop task"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
