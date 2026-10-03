import {
  CardsIcon,
  PauseIcon,
  PlayIcon,
  ProhibitIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import type { ConductorCommandPayload } from "@ace/protocol";
import { CardGraph } from "./card-graph.tsx";
import { DeckGate } from "./deck-gate.tsx";
import {
  deckBrief,
  deckErrorText,
  deckStepper,
  defaultCard,
  formatAgo,
  type DeckRun,
} from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { AgentList } from "./agent-list.tsx";
import { useDeckRun, useDeckSender } from "./deck-source.ts";
import { DeckStepper } from "./deck-stepper.tsx";
import { LanesTab } from "./deck-tabs.tsx";
import { LaneDetail } from "./lane-detail.tsx";
import { useProjectName } from "@/lib/projects.ts";

export type DeckTab = "plan" | "lanes";
const tabs = [
  { value: "plan", label: "Plan" },
  { value: "lanes", label: "Lanes" },
] as const satisfies readonly { value: DeckTab; label: string }[];

/**
 * One deck: goal, stepper, the gate when one is open, then Plan (cards and the selected
 * lane) or Lanes. Tab and selected card live in the URL so back and forward work.
 */
export function DeckRunPage(props: {
  runId: string;
  tab: DeckTab;
  card: string | undefined;
  onNavigate(next: { tab?: DeckTab; card?: string }): void;
}) {
  const { ready, run } = useDeckRun(props.runId);
  if (!run)
    return (
      <Screen title="Deck">
        {ready ? (
          <EmptyState
            icon={CardsIcon}
            heading
            title="This deck isn't here"
            description="It may have been removed, or it lives on another daemon."
          />
        ) : (
          <DeckSkeleton />
        )}
      </Screen>
    );
  return <RunScreen {...props} run={run} />;
}

function RunScreen(props: {
  run: DeckRun;
  tab: DeckTab;
  card: string | undefined;
  onNavigate(next: { tab?: DeckTab; card?: string }): void;
}) {
  const { run } = props;
  const sender = useDeckSender();
  const toast = useToast();
  const projectName = useProjectName();
  const [cancelling, setCancelling] = useState(false);
  const selected = run.cards.find((c) => c.id === props.card) ?? defaultCard(run);
  const send = (payload: ConductorCommandPayload, done: string) =>
    sender(payload).then(
      () => toast.add({ title: done }),
      (error: unknown) =>
        toast.add({ title: error instanceof Error ? error.message : "The deck didn't answer." }),
    );
  const brief = deckBrief(run.goal, run.title);
  const paused = run.phase === "paused";
  const running =
    run.phase === "planning" ||
    run.phase === "dealing" ||
    run.phase === "merging" ||
    run.phase === "failed";
  return (
    <Screen
      title={run.title}
      subtitle={`${projectName(run.workspaceId)} · Deck`}
      menu={
        running || paused ? (
          <MenuItem danger onClick={() => setCancelling(true)}>
            Cancel deck…
          </MenuItem>
        ) : undefined
      }
      actions={
        paused || run.phase === "failed" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void send({ type: "conductor.resume", runId: run.id }, "Deck resumed")}
          >
            <Icon icon={PlayIcon} size={14} />
            Resume deck
          </Button>
        ) : running ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void send({ type: "conductor.pause", runId: run.id }, "Deck paused")}
          >
            <Icon icon={PauseIcon} size={14} />
            Pause deck
          </Button>
        ) : undefined
      }
    >
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-[1120px] px-9 pt-10 pb-20">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl font-semibold tracking-title">{run.title}</h2>
              {brief && (
                <p className="mt-1 max-w-[62ch] text-base leading-normal text-muted-foreground">
                  {brief}
                </p>
              )}
              <RunTimes run={run} />
              <DeckStepper {...deckStepper(run)} />
            </div>
            <SegmentedControl
              label="Deck view"
              value={props.tab}
              options={tabs}
              onValueChange={(tab) => props.onNavigate({ tab })}
            />
          </div>
          <RunNotice run={run} />
          {run.gate && (
            <DeckGate
              run={run}
              gate={run.gate}
              onOpenCard={(card) => props.onNavigate({ tab: "plan", card })}
            />
          )}
          {props.tab === "plan" && (
            <section aria-label="Cards" className="mt-[30px]">
              <h2 className="flex items-baseline gap-2.5 text-md font-medium">
                Cards
                <span className="text-sm font-normal text-subtle-foreground">
                  select one to see its lane
                </span>
              </h2>
              {run.cards.length ? (
                <CardGraph
                  run={run}
                  selected={selected?.id}
                  onSelect={(card) => props.onNavigate({ tab: "plan", card })}
                />
              ) : (
                <PlanPending run={run} />
              )}
              {selected && <LaneDetail card={selected} run={run} />}
            </section>
          )}
          {props.tab === "lanes" && (
            <LanesTab run={run} onOpen={(card) => props.onNavigate({ tab: "plan", card })} />
          )}
        </div>
      </div>
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this deck?</DialogTitle>
            <DialogDescription>
              Every lane stops, its sub-agents included, and nothing else merges. Cards already
              merged into the deck's branch stay there.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCancelling(false)}>
              Keep it running
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setCancelling(false);
                void send({ type: "conductor.cancel", runId: run.id }, "Stopping the deck");
              }}
            >
              Cancel deck
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Screen>
  );
}

/** "Started 2h ago · updated 3m ago", from the daemon's own times for the run. */
function RunTimes(props: { run: DeckRun }) {
  const now = useNow();
  const { startedAt, updatedAt } = props.run;
  if (!startedAt) return null;
  return (
    <p className="mt-2 text-sm text-subtle-foreground tabular-nums">
      Started {formatAgo(startedAt, now)}
      {updatedAt > startedAt && <> · updated {formatAgo(updatedAt, now)}</>}
    </p>
  );
}

/**
 * Why a deck isn't moving when that isn't a decision: it is stopping, it was cancelled, or the
 * daemon couldn't run its next step (which survives a restart until it resumes).
 */
function RunNotice(props: { run: DeckRun }) {
  const { run } = props;
  const notice =
    run.phase === "failed"
      ? {
          title: "The deck stopped.",
          body: deckErrorText(run.error ?? "conductor_execution_failed"),
        }
      : run.phase === "stopping"
        ? {
            title: "Stopping the deck.",
            body: "Each lane is being interrupted; the deck reads Cancelled once every one of them has stopped.",
          }
        : run.phase === "cancelled"
          ? {
              title: "This deck was cancelled.",
              body: "Its threads stay, so you can read what each lane did.",
            }
          : undefined;
  if (!notice) return null;
  return (
    <p
      role={run.phase === "failed" ? "alert" : "status"}
      className="mt-[22px] flex items-start gap-2.5 rounded-lg px-4 py-3 text-ui text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]"
    >
      {run.phase === "stopping" ? (
        <Spinner className="mt-0.5" />
      ) : (
        <Icon
          icon={run.phase === "failed" ? WarningCircleIcon : ProhibitIcon}
          size={16}
          className={cn("mt-0.5 shrink-0", run.phase === "failed" && "text-status-failed")}
        />
      )}
      <span>
        <span className="font-medium text-foreground">{notice.title}</span> {notice.body}
      </span>
    </p>
  );
}

/** Before the plan exists: the planner at work, and its thread. */
function PlanPending(props: { run: DeckRun }) {
  const { run } = props;
  return (
    <div className="mt-3.5 rounded-lg px-5 py-[18px] shadow-[inset_0_0_0_1px_var(--border)]">
      <p className="flex items-center gap-2 text-ui text-muted-foreground">
        {run.phase === "planning" && <Spinner />}
        {run.phase === "planning"
          ? "The planner is splitting the goal into cards."
          : "This deck has no cards."}
      </p>
      <AgentList label="Planner" agents={run.agents} />
    </div>
  );
}

/** The deck's shape while it loads: title, goal, stepper, then a row of card columns. */
function DeckSkeleton() {
  return (
    <LoadingRegion label="deck" className="flex flex-col gap-3 px-9 pt-11">
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-3.5 w-[28rem] max-w-full" />
      <Skeleton className="mt-3 h-3 w-96 max-w-full" />
      <div className="mt-8 grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }, (_, column) => (
          <span key={column} className="flex flex-col gap-3">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton
              className="h-16 rounded-card"
              style={{ animationDelay: `${column * 80}ms` }}
            />
          </span>
        ))}
      </div>
    </LoadingRegion>
  );
}
