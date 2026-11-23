import { parseSpadeTask } from "@ace/ui-core/spade-chat";
import { XIcon } from "@ace/icons";
import { useMemo } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { pillButton, ProfileSection } from "../spade-profile-parts.tsx";
import { WorkGoal, WorkPlan } from "../spade-work-goal.tsx";
import type { RosterBot } from "../use-spade-roster.ts";
import { LaneRows } from "./lane-list.tsx";
import { laneCost, laneLive, type LaneFixture } from "./lanes-fixture.ts";
import { setLanesPlace } from "./lanes-place.ts";

/*
 * Prototype (ADR 0217 §7): what the panel beside the chat shows for lanes, in the profile's place
 * and frame: the task list (the second layout the owner is choosing between), or, with a lane
 * open, that lane's goal and plan.
 */

function PanelHead(props: { title: string; onClose(): void }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-4">
      <h2 className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{props.title}</h2>
      <IconButton icon={XIcon} label={`Close ${props.title}`} tip="Close" onClick={props.onClose} />
    </div>
  );
}

/** The task list as a panel beside the chat. */
export function LanesPanel(props: { bot: RosterBot; lanes: readonly LaneFixture[] }) {
  return (
    <section aria-label="Tasks" className="flex h-full min-h-0 flex-col">
      <PanelHead title="Tasks" onClose={() => setLanesPlace({ panel: false })} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        <LaneRows lanes={props.lanes} avatar={props.bot.avatar} />
      </div>
    </section>
  );
}

/** An open lane's goal, criteria and plan, as Work shows a bot's, with Stop at the foot. */
export function LaneWorkPanel(props: { bot: RosterBot; lane: LaneFixture }) {
  const { bot, lane } = props;
  const task = useMemo(() => parseSpadeTask(JSON.stringify({ task: lane.task })), [lane.task]);
  return (
    <section aria-label={`${lane.title}: goal and plan`} className="flex h-full min-h-0 flex-col">
      <PanelHead title="Goal and plan" onClose={() => setLanesPlace({ lane: undefined })} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-8">
        {task && <WorkGoal bot={bot} task={task} />}
        {task && (
          <WorkPlan
            task={task}
            evidenceWords={(evidence) =>
              evidence.kind === "file"
                ? evidence.path
                : evidence.kind === "url"
                  ? evidence.url.replace(/^https?:\/\//, "")
                  : "A command's output"
            }
            onEvidence={() => undefined}
          />
        )}
        <ProfileSection label="Spent">
          <p className="px-3.5 py-2.5 text-ui text-foreground">
            {laneCost(lane.costMicros)}
            <span className="text-muted-foreground"> on the tasks model</span>
          </p>
        </ProfileSection>
        {laneLive(lane) && (
          <div className="mt-6 -ml-3.5 flex">
            <Button variant="ghost" tone="danger" className={cn(pillButton)}>
              Stop task
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
