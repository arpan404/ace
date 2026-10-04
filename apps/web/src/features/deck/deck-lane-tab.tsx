import { ArrowUpRightIcon, CardsIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { cardStatus, deckRunSummary, type DeckCard } from "@ace/ui-core";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { StatusMark } from "./card-graph.tsx";
import { useDeckRun } from "./deck-source.ts";
import { LaneDetail } from "./lane-detail.tsx";

/** Whether `threadId` works on `card`: its lane's thread, or one the deck delegated for it. */
const worksOn = (card: DeckCard, threadId: string) =>
  card.lane?.threadId === threadId || card.agents.some((agent) => agent.threadId === threadId);

/**
 * One deck lane as a workspace tab beside a thread: the card's worker and reviewer, its review
 * rounds and every agent the deck delegated for it, with the way back to the whole deck.
 */
export function DeckLaneTab(props: { runId: string; cardId: string }) {
  const { ready, run } = useDeckRun(props.runId);
  const card = run?.cards.find((candidate) => candidate.id === props.cardId);
  if (!run)
    return ready ? (
      <EmptyState
        icon={CardsIcon}
        title="This deck isn't on the daemon"
        description="It may have been removed, or it ran on another daemon. Close this tab, or look for it in Deck."
        action={
          <Link to="/deck" className={buttonVariants({ size: "sm", variant: "outline" })}>
            Open Deck
          </Link>
        }
      />
    ) : (
      <LoadingRegion label="lane" className="flex flex-col gap-3 px-4 pt-4">
        <Skeleton className="h-4 w-40" />
        <SkeletonText lines={3} />
      </LoadingRegion>
    );
  return (
    <div className="px-4 pt-2 pb-8">
      <div className="flex h-10 items-center gap-2 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          <b className="font-medium text-foreground">{run.title}</b> · {deckRunSummary(run)}
        </span>
        <Link
          to="/deck/$runId"
          params={{ runId: run.id }}
          search={{ tab: "plan", card: props.cardId }}
          className={buttonVariants({ size: "sm", variant: "ghost" })}
        >
          Open deck
          <ArrowUpRightIcon aria-hidden size={12} />
        </Link>
      </div>
      {card ? (
        <LaneDetail card={card} run={run} beside={false} />
      ) : (
        <EmptyState
          icon={CardsIcon}
          title="This lane isn't in the plan any more"
          description="The deck's plan changed since this tab opened. The deck itself lists the lanes it has now."
          className="h-auto pt-12"
        />
      )}
    </div>
  );
}

/**
 * Inside a thread's Agents tab, for a thread a deck owns: the deck and its lanes, grouped under
 * it, each opening as a lane tab. The lane this thread works on is marked.
 */
export function DeckOfThread(props: {
  runId: string;
  threadId: string;
  onOpenLane(lane: { runId: string; cardId: string; title: string }): void;
}) {
  const { ready, run } = useDeckRun(props.runId);
  if (!run)
    return ready ? (
      <p className="px-2 py-1.5 text-sm text-muted-foreground">
        This thread belongs to a deck the daemon no longer lists.
      </p>
    ) : (
      <LoadingRegion label="deck" className="px-2 py-1.5">
        <Skeleton className="h-4 w-48" />
      </LoadingRegion>
    );
  return (
    <div>
      <Link
        to="/deck/$runId"
        params={{ runId: run.id }}
        search={{ tab: "plan" }}
        className="flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-ui outline-none hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)]"
      >
        <CardsIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{run.title}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
          {deckRunSummary(run)}
        </span>
        <ArrowUpRightIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </Link>
      <ul aria-label={`Lanes of ${run.title}`}>
        {run.cards.map((card) => {
          const status = cardStatus(card, run);
          const mine = worksOn(card, props.threadId);
          return (
            <li key={card.id}>
              <button
                type="button"
                onClick={() =>
                  props.onOpenLane({ runId: run.id, cardId: card.id, title: card.title })
                }
                className={cn(
                  "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg pr-2 pl-[30px] text-left text-ui outline-none hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)]",
                  !card.lane && "text-muted-foreground",
                )}
              >
                <span className="grid w-3.5 shrink-0 place-items-center text-muted-foreground">
                  <StatusMark mark={status.mark} tone={status.tone} />
                </span>
                <span className="min-w-0 shrink truncate">{card.title}</span>
                {mine && (
                  <span className="shrink-0 text-xs text-muted-foreground">this thread</span>
                )}
                <span className="min-w-0 flex-1 truncate text-right text-xs text-subtle-foreground">
                  {status.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
