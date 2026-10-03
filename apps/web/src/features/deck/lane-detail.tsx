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

/** A card's lane: worker and adversarial reviewer, then each review round and its findings. */
export function LaneDetail(props: { card: DeckCard; run: DeckRun }) {
  const { card } = props;
  const status = cardStatus(card, props.run);
  const lane = card.lane;
  return (
    <section
      aria-label={`Lane: ${card.title}`}
      className="mt-[26px] animate-in rounded-lg px-5 py-[18px] shadow-[inset_0_0_0_1px_var(--border)] fade-in-0"
    >
      <div className="flex items-center gap-2.5">
        <h2 className="min-w-0 flex-1 text-md font-medium">{card.title}</h2>
        <StatusPill tone={lane ? pillTone[status.tone] : "idle"} label={status.label} />
        {lane?.threadId && (
          <Link
            to="/t/$threadId"
            params={{ threadId: lane.threadId }}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Open thread
          </Link>
        )}
      </div>
      {lane ? (
        <>
          <div className="mt-3.5 grid grid-cols-2 gap-3.5">
            <RoleCard label="Worker" role={lane.worker} />
            <RoleCard label="Reviewer" role={lane.reviewer} />
          </div>
          <ol aria-label="Review rounds" className="mt-4">
            {lane.rounds.map((round) => (
              <li
                key={round.label}
                className="grid grid-cols-[84px_minmax(0,1fr)] gap-3 border-t py-2.5 text-ui"
              >
                <span className="font-medium text-subtle-foreground">{round.label}</span>
                <div className="leading-normal">
                  <span className="font-medium">{round.verdict}</span>
                  {round.detail && <span className="text-muted-foreground"> · {round.detail}</span>}
                  {round.findings.length > 0 && (
                    <ul aria-label="Findings">
                      {round.findings.map((finding) => (
                        <li
                          key={finding.text}
                          className="mt-1.5 flex items-start gap-2 text-muted-foreground"
                        >
                          <span className="shrink-0 pt-0.5 font-mono text-[11px] text-status-needs-you">
                            {finding.severity}
                          </span>
                          <span>{finding.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="mt-2 text-ui text-muted-foreground">{card.note}</p>
      )}
    </section>
  );
}

function RoleCard(props: { label: string; role: LaneRole }) {
  return (
    <div className="rounded-card bg-muted px-3.5 py-3">
      <div className="text-xs font-medium tracking-[0.01em] text-subtle-foreground">
        {props.label}
      </div>
      <div className="mt-[3px] text-[13.5px] font-medium">{props.role.account}</div>
      <div className="mt-0.5 text-sm text-muted-foreground">{props.role.detail}</div>
    </div>
  );
}
