import { CardsIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { ConductorCommandPayload } from "@ace/protocol";
import { CardGraph } from "./card-graph.tsx";
import { DeckGate } from "./deck-gate.tsx";
import { deckStepper, defaultCard, type DeckRun } from "@ace/ui-core";
import { useDeckRun, useDeckSource } from "./deck-source.ts";
import { DeckStepper } from "./deck-stepper.tsx";
import { LanesTab, LogTab, PlanChanges } from "./deck-tabs.tsx";
import { LaneDetail } from "./lane-detail.tsx";

export type DeckTab = "plan" | "lanes" | "log";
const tabs = [
  { value: "plan", label: "Plan" },
  { value: "lanes", label: "Lanes" },
  { value: "log", label: "Log" },
] as const satisfies readonly { value: DeckTab; label: string }[];

/**
 * One deck: goal, stepper, the gate when one is open, then Plan (cards and the selected
 * lane), Lanes or Log. Tab and selected card live in the URL so back and forward work.
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
        {ready && (
          <EmptyState
            icon={CardsIcon}
            heading
            title="This deck isn't here"
            description="It may have been removed, or it lives on another daemon."
          />
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
  const source = useDeckSource();
  const toast = useToast();
  const { setTab, setPanelOpen } = useLayout();
  const selected = run.cards.find((c) => c.id === props.card) ?? defaultCard(run);
  const send = (payload: ConductorCommandPayload, done: string) =>
    source.send(payload).then(
      () => toast.add({ title: done }),
      (error: unknown) =>
        toast.add({ title: error instanceof Error ? error.message : "The deck didn't answer." }),
    );
  const paused = run.phase === "paused";
  const running = run.phase === "planning" || run.phase === "dealing" || run.phase === "merging";
  return (
    <Screen
      title={run.title}
      subtitle={`${run.workspaceId} · Deck`}
      menu={
        <>
          <MenuItem onClick={() => void navigator.clipboard?.writeText(run.branch)}>
            Copy branch name
          </MenuItem>
          {(running || paused) && (
            <MenuItem
              danger
              onClick={() =>
                void send({ type: "conductor.cancel", runId: run.id }, "Deck cancelled")
              }
            >
              Cancel deck
            </MenuItem>
          )}
        </>
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
      right={{
        label: "Deck panel",
        tabs: [
          { id: "plan-changes", label: "Plan changes", content: <PlanChanges gate={run.gate} /> },
        ],
      }}
    >
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-[1120px] px-9 pt-10 pb-20">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl font-semibold tracking-title">{run.title}</h2>
              <p className="mt-1 max-w-[62ch] text-base leading-normal text-muted-foreground">
                {run.goal}
              </p>
              <DeckStepper {...deckStepper(run)} />
            </div>
            <SegmentedControl
              label="Deck view"
              value={props.tab}
              options={tabs}
              onValueChange={(tab) => props.onNavigate({ tab })}
            />
          </div>
          {run.gate && (
            <DeckGate
              run={run}
              gate={run.gate}
              onReview={() => {
                setTab("right", "plan-changes");
                setPanelOpen("right", true);
              }}
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
          {props.tab === "log" && <LogTab run={run} />}
        </div>
      </div>
    </Screen>
  );
}
