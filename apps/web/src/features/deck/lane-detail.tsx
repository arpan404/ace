import { Link } from "@tanstack/react-router";
import { useSidebarThread } from "@ace/client-react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { StatusPill } from "@/components/status-pill.tsx";
import { useNow } from "@/lib/time.ts";
import {
  type Tone,
  cardStatus,
  formatAgo,
  type CardTone,
  type DeckCard,
  type DeckRun,
  type LaneRole,
} from "@ace/ui-core";
import { AgentList } from "./agent-list.tsx";

const pillTone: Record<CardTone, Tone> = {
  idle: "idle",
  waiting: "waiting",
  "needs-you": "needs-you",
  working: "working",
  done: "done",
};

/**
 * A card's lane: worker and adversarial reviewer, its review rounds so far, then every agent the
 * deck delegated for it (sub-agents included), each with a way into its thread.
 */
export function LaneDetail(props: { card: DeckCard; run: DeckRun }) {
  const { card } = props;
  const status = cardStatus(card, props.run);
  const lane = card.lane;
  return (
    <section
      aria-label={`Lane: ${card.title}`}
      className="fx-rise-in mt-[26px] rounded-lg px-5 py-[18px] shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-medium">{card.title}</h2>
          <CardTimes card={card} />
        </div>
        <StatusPill tone={lane ? pillTone[status.tone] : "idle"} label={status.label} />
        {lane?.threadId && <OpenThread threadId={lane.threadId} />}
      </div>
      {lane ? (
        <>
          <div className="mt-3.5 grid grid-cols-2 gap-3.5">
            <RoleCard label="Worker" role={lane.worker} />
            <RoleCard label="Reviewer" role={lane.reviewer} />
          </div>
          {lane.rounds.length > 0 && (
            <ol aria-label="Review rounds" className="mt-4">
              {lane.rounds.map((round) => (
                <li
                  key={round.label}
                  className="grid grid-cols-[84px_minmax(0,1fr)] gap-3 border-t py-2.5 text-ui"
                >
                  <span className="font-medium text-subtle-foreground">{round.label}</span>
                  <span className="font-medium">{round.verdict}</span>
                </li>
              ))}
            </ol>
          )}
          {card.agents.length > 0 && (
            <div className="mt-2">
              <h3 className="text-xs font-medium tracking-[0.01em] text-subtle-foreground">
                Agents
              </h3>
              <AgentList label={`Agents on ${card.title}`} agents={card.agents} />
            </div>
          )}
        </>
      ) : (
        <p className="mt-2 text-ui text-muted-foreground">{card.note}</p>
      )}
    </section>
  );
}

/** "Started 12m ago · updated 1m ago", from the card's agent threads. */
function CardTimes(props: { card: DeckCard }) {
  const now = useNow();
  const { startedAt, updatedAt } = props.card;
  if (startedAt === undefined) return null;
  return (
    <p className="mt-0.5 text-sm text-subtle-foreground tabular-nums">
      Started {formatAgo(startedAt, now)}
      {updatedAt !== undefined && updatedAt > startedAt && (
        <> · updated {formatAgo(updatedAt, now)}</>
      )}
    </p>
  );
}

/** The lane's current thread, once this client lists it. */
function OpenThread(props: { threadId: string }) {
  const thread = useSidebarThread(props.threadId);
  if (!thread) return null;
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      className={buttonVariants({ variant: "ghost", size: "sm" })}
    >
      Open thread
    </Link>
  );
}

function RoleCard(props: { label: string; role: LaneRole | null }) {
  return (
    <div className="rounded-card bg-muted px-3.5 py-3">
      <div className="text-xs font-medium tracking-[0.01em] text-subtle-foreground">
        {props.label}
      </div>
      {props.role ? (
        <>
          <div className="mt-[3px] text-[13.5px] font-medium">{props.role.account}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{props.role.detail}</div>
        </>
      ) : (
        <div className="mt-[3px] text-[13.5px] text-muted-foreground">Not assigned yet</div>
      )}
    </div>
  );
}
