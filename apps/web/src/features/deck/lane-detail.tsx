import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { StatusPill } from "@/components/status-pill.tsx";
import {
  type Tone,
  cardStatus,
  type CardTone,
  type DeckCard,
  type DeckRun,
  type LaneRole,
} from "@ace/ui-core";

const pillTone: Record<CardTone, Tone> = {
  idle: "idle",
  waiting: "waiting",
  "needs-you": "needs-you",
  working: "working",
  done: "done",
};

/** A card's lane: worker and adversarial reviewer, then its review rounds so far. */
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
        <h2 className="min-w-0 flex-1 text-md font-medium">{card.title}</h2>
        <StatusPill tone={lane ? pillTone[status.tone] : "idle"} label={status.label} />
        {lane && <OpenThread agentId={lane.agentId} />}
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
        </>
      ) : (
        <p className="mt-2 text-ui text-muted-foreground">{card.note}</p>
      )}
    </section>
  );
}

/** A lane's agent runs as a delegated thread on this daemon when the daemon lists one. */
function OpenThread(props: { agentId: string }) {
  const thread = useSidebarThread(props.agentId);
  if (!thread) return null;
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.agentId }}
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
