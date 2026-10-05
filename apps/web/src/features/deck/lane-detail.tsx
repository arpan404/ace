import { CopyIcon, GitDiffIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useSidebarThread } from "@ace/client-react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Icon } from "@/components/icon.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { deckLaneTab } from "@/features/panels/index.ts";
import { StatusPill } from "@/components/status-pill.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import {
  type Tone,
  cardStatus,
  formatAgo,
  type CardTone,
  type DeckCard,
  type DeckRun,
  type LaneRole,
  type Round,
} from "@ace/ui-core";
import { AgentList } from "./agent-list.tsx";
import { useDeckToast } from "./deck-keys.ts";

const pillTone: Record<CardTone, Tone> = {
  idle: "idle",
  waiting: "waiting",
  "needs-you": "needs-you",
  working: "working",
  done: "done",
};

/** The thread whose worktree holds a card's changes: its worker's (or fixer's), else its lane's. */
export function changesThread(card: DeckCard): string | null {
  const worker = card.agents.find(
    (agent) => !agent.nested && (agent.role === "worker" || agent.role === "integrator"),
  );
  return worker?.threadId ?? card.lane?.threadId ?? null;
}

/**
 * A card's lane: worker and adversarial reviewer, its review rounds so far, then every agent the
 * deck delegated for it (sub-agents included), each with a way into its thread.
 */
export function LaneDetail(props: {
  card: DeckCard;
  run: DeckRun;
  /** Offer to open the lane as a tab beside its thread (not when it already is one). */
  beside?: boolean;
  /** The thread this lane is shown beside: no "Open thread" to where the person already is. */
  scope?: string;
  className?: string;
}) {
  const { card } = props;
  const status = cardStatus(card, props.run);
  const lane = card.lane;
  const threadId = lane?.threadId;
  return (
    <section
      aria-label={`Lane: ${card.title}`}
      className={cn(
        "fx-rise-in rounded-lg px-5 py-[18px] shadow-[inset_0_0_0_1px_var(--border)]",
        props.className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="text-md font-medium text-pretty">{card.title}</h3>
          <CardTimes card={card} />
        </div>
        <StatusPill tone={lane ? pillTone[status.tone] : "idle"} label={status.label} />
        {threadId && threadId !== props.scope && (
          <span className="flex items-center gap-1 max-sm:basis-full">
            <OpenThread
              threadId={threadId}
              lane={props.beside === false ? undefined : { run: props.run, card }}
            />
          </span>
        )}
      </div>
      {card.state === "merged" && <MergeResult card={card} run={props.run} />}
      {lane ? (
        <>
          <div className="mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <RoleCard label="Worker" role={lane.worker} />
            <RoleCard label="Reviewer" role={lane.reviewer} />
          </div>
          {lane.rounds.length > 0 && (
            <ol aria-label="Review rounds" className="mt-4">
              {lane.rounds.map((round) => (
                <RoundRow key={round.label} round={round} />
              ))}
            </ol>
          )}
          {card.agents.length > 0 && (
            <div className="mt-2">
              <h4 className="text-xs font-medium tracking-[0.01em] text-muted-foreground">
                Agents
              </h4>
              <AgentList label={`Agents on ${card.title}`} agents={card.agents} />
            </div>
          )}
        </>
      ) : (
        card.state !== "merged" && <p className="mt-2 text-ui text-muted-foreground">{card.note}</p>
      )}
    </section>
  );
}

const roundTone: Record<NonNullable<Round["tone"]>, Tone> = {
  done: "done",
  "needs-you": "needs-you",
  working: "working",
};

/** One review round: its verdict, and what the reviewer said when the daemon reports it. */
function RoundRow(props: { round: Round }) {
  const { round } = props;
  return (
    <li className="grid grid-cols-[84px_minmax(0,1fr)] items-start gap-3 border-t py-2.5 text-ui">
      <span className="pt-0.5 font-medium text-muted-foreground">{round.label}</span>
      <span className="min-w-0">
        {round.tone ? (
          <StatusPill tone={roundTone[round.tone]} label={round.verdict} />
        ) : (
          <span className="font-medium">{round.verdict}</span>
        )}
        {round.summary && (
          <span className="mt-1 block text-sm leading-[1.45] text-pretty text-muted-foreground">
            {round.summary}
          </span>
        )}
      </span>
    </li>
  );
}

/** "Merged at abc1234 into deck/x", with the revision to copy and the card's changes. */
function MergeResult(props: { card: DeckCard; run: DeckRun }) {
  const toast = useDeckToast();
  const revision = /^Merged at ([0-9a-f]{7})/.exec(props.card.note)?.[1];
  const thread = changesThread(props.card);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-ui text-muted-foreground">
      <span className="min-w-0">
        Merged
        {revision && (
          <>
            {" "}
            at <code className="rounded-xs bg-muted px-1 font-mono text-sm">{revision}</code>
          </>
        )}
        {props.run.branch && (
          <>
            {" "}
            into{" "}
            <code className="rounded-xs bg-muted px-1 font-mono text-sm">{props.run.branch}</code>
          </>
        )}
      </span>
      {revision && (
        <IconButton
          icon={CopyIcon}
          label="Copy revision"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(revision).then(
              () => toast.done(`Copied ${revision}`),
              () => toast.error("Couldn't copy the revision."),
            )
          }
        />
      )}
      {thread && <ViewChanges threadId={thread} className="ml-auto" />}
    </div>
  );
}

/** Open a card's worker thread on its Changes tab, once this client lists that thread. */
export function ViewChanges(props: {
  threadId: string;
  className?: string;
  variant?: "ghost" | "secondary";
}) {
  const thread = useSidebarThread(props.threadId);
  const workspace = useWorkspaceActions(props.threadId);
  const navigate = useNavigate();
  return (
    <Button
      size="sm"
      variant={props.variant ?? "ghost"}
      disabled={!thread}
      className={props.className}
      onClick={() => {
        workspace.open({ kind: "changes" });
        void navigate({ to: "/t/$threadId", params: { threadId: props.threadId } });
      }}
    >
      <Icon icon={GitDiffIcon} size={14} />
      View changes
    </Button>
  );
}

/** "Started 12m ago · updated 1m ago", from the card's agent threads. */
function CardTimes(props: { card: DeckCard }) {
  const now = useNow();
  const { startedAt, updatedAt } = props.card;
  if (startedAt === undefined) return null;
  return (
    <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
      Started {formatAgo(startedAt, now)}
      {updatedAt !== undefined && updatedAt > startedAt && (
        <> · updated {formatAgo(updatedAt, now)}</>
      )}
    </p>
  );
}

/**
 * The lane's current thread: open it, or open it with this lane as a tab beside its
 * conversation. The buttons hold their place while this client hasn't listed the thread yet,
 * so the header doesn't jump when it arrives.
 */
function OpenThread(props: {
  threadId: string;
  lane: { run: DeckRun; card: DeckCard } | undefined;
}) {
  const thread = useSidebarThread(props.threadId);
  const workspace = useWorkspaceActions(props.threadId);
  const navigate = useNavigate();
  const { lane } = props;
  return (
    <>
      {lane && (
        <Button
          size="sm"
          variant="ghost"
          disabled={!thread}
          onClick={() => {
            workspace.open(
              deckLaneTab({ runId: lane.run.id, cardId: lane.card.id, title: lane.card.title }),
            );
            void navigate({ to: "/t/$threadId", params: { threadId: props.threadId } });
          }}
        >
          Open beside thread
        </Button>
      )}
      {thread ? (
        <Link
          to="/t/$threadId"
          params={{ threadId: props.threadId }}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Open thread
        </Link>
      ) : (
        <Button size="sm" variant="ghost" disabled>
          Open thread
        </Button>
      )}
    </>
  );
}

function RoleCard(props: { label: string; role: LaneRole | null }) {
  return (
    <div className="min-w-0 rounded-card bg-muted px-3.5 py-3">
      <div className="text-xs font-medium tracking-[0.01em] text-muted-foreground">
        {props.label}
      </div>
      {props.role ? (
        <>
          <div className="mt-[3px] text-ui font-medium break-words">{props.role.account}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{props.role.detail}</div>
        </>
      ) : (
        <div className="mt-[3px] text-ui text-muted-foreground">Not assigned yet</div>
      )}
    </div>
  );
}
