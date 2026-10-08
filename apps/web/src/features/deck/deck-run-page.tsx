import {
  ArrowClockwiseIcon,
  CardsIcon,
  PauseIcon,
  PlayIcon,
  ProhibitIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
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
import { PageTitle, Screen } from "@/features/shell/index.ts";
import type { ConductorCommandPayload } from "@ace/protocol";
import { CardGraph } from "./card-graph.tsx";
import { DeckGates } from "./deck-gate.tsx";
import {
  cardColumns,
  cardStatus,
  deckBrief,
  deckErrorText,
  deckStepper,
  defaultCard,
  formatAgo,
  motionMs,
  type DeckRun,
} from "@ace/ui-core";
import { useHotkey } from "@/lib/hotkeys.ts";
import { prefersReducedMotion, usePresence } from "@/lib/motion.ts";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { AgentList } from "./agent-list.tsx";
import { deckKeys, failure, useDeckToast } from "./deck-keys.ts";
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

/** A plan this long reads better as Lanes first, unless the URL asks for the plan. */
const lanesFirstAbove = 16;

/**
 * One deck: goal, stepper, the gate when one is open, then Plan (cards and the selected
 * lane) or Lanes. Tab and selected card live in the URL so back and forward work.
 */
export function DeckRunPage(props: {
  runId: string;
  /** From the URL; a long plan opens on Lanes when it is missing. */
  tab: DeckTab | undefined;
  card: string | undefined;
  onNavigate(next: { tab?: DeckTab; card?: string | undefined }): void;
}) {
  const { ready, run } = useDeckRun(props.runId);
  if (!run)
    return (
      <Screen title="Offsets">
        {ready ? (
          <EmptyState
            icon={CardsIcon}
            heading
            title="This offset isn't here"
            description="It may have been removed, or it lives on another daemon."
            action={
              <span className="flex gap-2">
                <Link to="/offsets" className={buttonVariants({ variant: "secondary" })}>
                  Back to Offsets
                </Link>
                <Link to="/offsets/new" className={buttonVariants({ variant: "primary" })}>
                  New offset
                </Link>
              </span>
            }
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
  tab: DeckTab | undefined;
  card: string | undefined;
  onNavigate(next: { tab?: DeckTab; card?: string | undefined }): void;
}) {
  const { run } = props;
  const sender = useDeckSender();
  const toast = useDeckToast();
  const projectName = useProjectName();
  const [cancelling, setCancelling] = useState(false);
  const [collapse, setCollapse] = useState(false);
  const cardsHeading = useRef<HTMLHeadingElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const tab = props.tab ?? (run.cards.length > lanesFirstAbove ? "lanes" : "plan");
  const selected = run.cards.find((c) => c.id === props.card) ?? defaultCard(run);
  const send = (payload: ConductorCommandPayload, done: string) =>
    sender(payload).then(
      () => toast.done(done),
      (error: unknown) => toast.error(failure(error)),
    );
  const brief = deckBrief(run.goal, run.title);
  const paused = run.phase === "paused";
  const moving = ["planning", "dealing", "merging", "waiting"].includes(run.phase);
  const live = moving || paused || run.phase === "failed";

  /** A person picked a card: below the side-by-side width, bring its lane into view. */
  const select = (cardId: string) => {
    props.onNavigate({ tab: "plan", card: cardId });
    requestAnimationFrame(() =>
      lane.current?.scrollIntoView?.({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      }),
    );
  };
  const order = cardColumns(run.cards).flat();
  const step = (delta: 1 | -1) => {
    if (tab !== "plan" || !order.length) return;
    const at = order.findIndex((card) => card.id === selected?.id);
    const next = order[Math.min(order.length - 1, Math.max(0, at + delta))];
    if (next) select(next.id);
  };
  // WP-1: keymap.deckPlan / deckLanes / deckNextCard / deckPrevCard through useKeys().
  useHotkey(deckKeys.deckPlan.keys, () => props.onNavigate({ tab: "plan" }));
  useHotkey(deckKeys.deckLanes.keys, () => props.onNavigate({ tab: "lanes" }));
  useHotkey(deckKeys.deckNextCard.keys, () => step(1));
  useHotkey(deckKeys.deckPrevCard.keys, () => step(-1));

  const needsYou = run.cards.filter((card) => cardStatus(card, run).tone === "needs-you").length;
  const merged = run.cards.filter((card) => card.state === "merged").length;
  return (
    <Screen
      title={run.title}
      subtitle={`${projectName(run.workspaceId)} · Offsets`}
      menu={
        live ? (
          <MenuItem danger onClick={() => setCancelling(true)}>
            Cancel offset…
          </MenuItem>
        ) : undefined
      }
      actions={
        paused ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void send({ type: "conductor.resume", runId: run.id }, "Offset resumed")}
          >
            <Icon icon={PlayIcon} size={14} />
            Resume offset
          </Button>
        ) : moving ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void send({ type: "conductor.pause", runId: run.id }, "Offset paused")}
          >
            <Icon icon={PauseIcon} size={14} />
            Pause offset
          </Button>
        ) : undefined
      }
    >
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-[1120px] px-4 pt-10 pb-20 sm:px-9">
          <PageTitle
            title={run.title}
            lede={brief || undefined}
            actions={
              <SegmentedControl
                label="Offset view"
                value={tab}
                options={tabs}
                onValueChange={(next) => props.onNavigate({ tab: next })}
              />
            }
          />
          <div className="flex flex-wrap items-center gap-x-4">
            <RunTimes run={run} />
            <Budget run={run} />
          </div>
          <DeckStepper {...deckStepper(run)} />
          <RunNotice
            run={run}
            onRetry={() => void send({ type: "conductor.resume", runId: run.id }, "Trying again")}
            onCancel={() => setCancelling(true)}
          />
          <GateArea run={run} onOpenCard={select} />
          {tab === "plan" && (
            <section aria-labelledby="deck-cards" className="mt-[30px]">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <h2
                  id="deck-cards"
                  ref={cardsHeading}
                  tabIndex={-1}
                  className="rounded-xs text-md font-medium outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]"
                >
                  Cards
                </h2>
                {run.cards.length > 0 && (
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {run.cards.length} {run.cards.length === 1 ? "card" : "cards"}
                    {needsYou > 0 && ` · ${needsYou} ${needsYou === 1 ? "needs" : "need"} you`}
                  </span>
                )}
                {merged > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={collapse}
                    className="ml-auto"
                    onClick={() => setCollapse(!collapse)}
                  >
                    {collapse ? "Show merged cards" : "Collapse merged"}
                  </Button>
                )}
              </div>
              <div className="gap-6 xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
                <div className="min-w-0">
                  {run.cards.length ? (
                    <CardGraph
                      run={run}
                      selected={selected?.id}
                      collapseMerged={collapse}
                      onShowMerged={() => setCollapse(false)}
                      onSelect={select}
                      onEscape={() => cardsHeading.current?.focus()}
                    />
                  ) : (
                    <PlanPending run={run} />
                  )}
                </div>
                {selected && (
                  <div ref={lane} className="mt-3.5 xl:sticky xl:top-4">
                    <LaneDetail key={selected.id} card={selected} run={run} />
                  </div>
                )}
              </div>
            </section>
          )}
          {tab === "lanes" && (
            <LanesTab
              run={run}
              open={props.card}
              onOpen={(card) => props.onNavigate({ tab: "lanes", card })}
            />
          )}
        </div>
      </div>
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this offset?</DialogTitle>
            <DialogDescription>
              Every lane stops, its sub-agents included, and nothing else merges. Cards already
              merged into the offset's branch stay there.
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
                void send({ type: "conductor.cancel", runId: run.id }, "Stopping the offset");
              }}
            >
              Cancel offset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Screen>
  );
}

/**
 * The open decisions above the plan. When the last one closes the area folds away instead of
 * dropping the plan by its height in one frame.
 */
function GateArea(props: { run: DeckRun; onOpenCard(cardId: string): void }) {
  const open = !!props.run.gate;
  const presence = usePresence(open, motionMs.slow);
  // The run as it was with its last gate, shown while the area folds away.
  const [shown, setShown] = useState(props.run);
  if (open && shown !== props.run) setShown(props.run);
  if (!presence.mounted) return null;
  const leaving = presence.phase === "exit";
  return (
    <div
      // A leaving gate is already answered: out of reach and out of the accessibility tree.
      aria-hidden={leaving || undefined}
      inert={leaving}
      // The rows fold to nothing as the answered gate fades.
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-(--dur-3) ease-exit",
        leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="pt-5">
          <DeckGates run={open ? props.run : shown} onOpenCard={props.onOpenCard} />
        </div>
      </div>
    </div>
  );
}

/** "Started 2h ago · updated 3m ago", from the daemon's own times for the run. */
function RunTimes(props: { run: DeckRun }) {
  const now = useNow();
  const { startedAt, updatedAt } = props.run;
  if (!startedAt) return null;
  return (
    <p className="mt-2 text-sm text-muted-foreground tabular-nums">
      Started {formatAgo(startedAt, now)}
      {updatedAt > startedAt && <> · updated {formatAgo(updatedAt, now)}</>}
    </p>
  );
}

/** "12 of 50 lane starts", with a short bar that turns to the needs-you tone near the end. */
function Budget(props: { run: DeckRun }) {
  const { spent, budget } = props.run;
  if (budget <= 0) return null;
  const share = Math.min(1, spent / budget);
  const near = share >= 0.9;
  return (
    <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
      <span>
        {spent} of {budget} lane starts
      </span>
      <span
        role="progressbar"
        aria-label="Budget used"
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={Math.min(spent, budget)}
        className="h-1 w-16 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            "block h-full rounded-full",
            near ? "bg-status-needs-you" : "bg-subtle-foreground",
          )}
          style={{ width: `${share * 100}%` }}
        />
      </span>
    </p>
  );
}

/** Retrying can't bring back a project the daemon no longer has: cancelling is the way out. */
const unrecoverable = new Set(["deck_workspace_not_found"]);

/**
 * Why a deck isn't moving when that isn't a decision: it waits for an account, it can't take
 * its next step (which survives a restart until retried), it is stopping, or it was cancelled.
 */
function RunNotice(props: { run: DeckRun; onRetry(): void; onCancel(): void }) {
  const { run } = props;
  const error = run.error ?? "conductor_execution_failed";
  const notice =
    run.phase === "waiting"
      ? { title: "Waiting for a free account.", body: deckErrorText(error) }
      : run.phase === "failed"
        ? { title: "The offset can't take its next step.", body: deckErrorText(error) }
        : run.phase === "stopping"
          ? {
              title: "Stopping the offset.",
              body: "Each lane is being interrupted; the offset reads Cancelled once every one of them has stopped.",
            }
          : run.phase === "cancelled"
            ? {
                title: "This offset was cancelled.",
                body: "Its threads stay, so you can read what each lane did.",
              }
            : undefined;
  if (!notice) return null;
  const failed = run.phase === "failed";
  return (
    <div
      role={failed ? "alert" : "status"}
      className="mt-[22px] flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg px-4 py-3 text-ui text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]"
    >
      {run.phase === "stopping" || run.phase === "waiting" ? (
        <Spinner className="mt-0.5" />
      ) : (
        <Icon
          icon={failed ? WarningCircleIcon : ProhibitIcon}
          size={16}
          className={cn("mt-0.5 shrink-0", failed && "text-status-failed")}
        />
      )}
      <p className="min-w-0 flex-1 basis-48">
        <span className="font-medium text-foreground">{notice.title}</span> {notice.body}
      </p>
      {failed &&
        (unrecoverable.has(error) ? (
          <Button size="sm" variant="danger" onClick={props.onCancel}>
            Cancel offset…
          </Button>
        ) : (
          <Button size="sm" onClick={props.onRetry}>
            <Icon icon={ArrowClockwiseIcon} size={14} />
            Try again
          </Button>
        ))}
    </div>
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
          : "This offset has no cards."}
      </p>
      <AgentList label="Planner" agents={run.agents} />
    </div>
  );
}

/** The deck's shape while it loads: title, goal, stepper, then a row of card columns. */
export function DeckSkeleton() {
  return (
    <LoadingRegion label="offset" className="flex flex-col gap-3 px-4 pt-11 sm:px-9">
      <Skeleton className="h-6 w-64 max-w-full" />
      <Skeleton className="h-3.5 w-[28rem] max-w-full" />
      <Skeleton className="mt-3 h-3 w-96 max-w-full" />
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
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
