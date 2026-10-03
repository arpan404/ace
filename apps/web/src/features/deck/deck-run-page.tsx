import { CardsIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import type { ConductorCommandPayload } from "@ace/protocol";
import { CardGraph } from "./card-graph.tsx";
import { DeckGate } from "./deck-gate.tsx";
import { deckBrief, deckStepper, defaultCard, type DeckRun } from "@ace/ui-core";
import { useDeckRun, useDeckSender } from "./deck-source.ts";
import { DeckStepper } from "./deck-stepper.tsx";
import { LanesTab } from "./deck-tabs.tsx";
import { LaneDetail } from "./lane-detail.tsx";

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
  const selected = run.cards.find((c) => c.id === props.card) ?? defaultCard(run);
  const send = (payload: ConductorCommandPayload, done: string) =>
    sender(payload).then(
      () => toast.add({ title: done }),
      (error: unknown) =>
        toast.add({ title: error instanceof Error ? error.message : "The deck didn't answer." }),
    );
  const brief = deckBrief(run.goal, run.title);
  const paused = run.phase === "paused";
  const running = run.phase === "planning" || run.phase === "dealing" || run.phase === "merging";
  return (
    <Screen
      title={run.title}
      subtitle={`${run.workspaceId} · Deck`}
      menu={
        running || paused ? (
          <MenuItem
            danger
            onClick={() => void send({ type: "conductor.cancel", runId: run.id }, "Deck cancelled")}
          >
            Cancel deck
          </MenuItem>
        ) : undefined
      }
      actions={
        paused ? (
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
              <DeckStepper {...deckStepper(run)} />
            </div>
            <SegmentedControl
              label="Deck view"
              value={props.tab}
              options={tabs}
              onValueChange={(tab) => props.onNavigate({ tab })}
            />
          </div>
          {run.error && (
            <p role="alert" className="mt-[22px] text-ui text-muted-foreground">
              <span className="font-medium text-foreground">The deck stopped.</span> The daemon
              couldn't run its next step ({run.error}); resume it to try again.
            </p>
          )}
          {run.gate && <DeckGate run={run} gate={run.gate} />}
          {props.tab === "plan" && (
            <section aria-label="Cards" className="mt-[30px]">
              <h2 className="flex items-baseline gap-2.5 text-md font-medium">
                Cards
                <span className="text-sm font-normal text-subtle-foreground">
                  select one to see its lane
                </span>
              </h2>
              <CardGraph
                run={run}
                selected={selected?.id}
                onSelect={(card) => props.onNavigate({ tab: "plan", card })}
              />
              {selected && <LaneDetail card={selected} run={run} />}
            </section>
          )}
          {props.tab === "lanes" && (
            <LanesTab run={run} onOpen={(card) => props.onNavigate({ tab: "plan", card })} />
          )}
        </div>
      </div>
    </Screen>
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
