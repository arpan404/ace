import type { ProviderKind } from "@ace/protocol";
import {
  spadeShownSubagents,
  spadeSubagentHeader,
  spadeSubagentsSpan,
  type SpadeAvatar,
  type SpadeSubagentTone,
} from "@ace/ui-core/spade-chat";
import type { SubagentState } from "@ace/ui-core";
import { Fragment, useState, type ReactNode } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { CardSecondary } from "./spade-card.tsx";
import { SpadeFace } from "./spade-face.tsx";

/*
 * The subagent card (docs/design/spade.md, "Workers it started"): the agents one call of a bot
 * started, on the bot's bubble with no edge or lift, as the bot's own output. Its first line is
 * the bot's face and one sentence; under it, on the same left edge, one row per agent: its mark
 * and name, its state in words and what it does now, how long it has run, and Open. One that
 * waits on the person is raised in place with its action. Past five rows the rest fold into
 * "and 3 more". A Suit reaches it as `card` `spade-subagents`.
 */

/** One agent as its row shows it; what it says comes from `@ace/ui-core/spade-chat`. */
export interface SpadeSubagentRowView {
  id: string;
  kind: "ace" | "bot";
  title: string;
  state: SubagentState;
  /** Its state in words, or the stale word while what the card reads isn't current. */
  stateWords: string;
  tone: SpadeSubagentTone | "stale";
  step: string | undefined;
  /** An ace agent's provider, for its quiet mark. */
  provider: ProviderKind | undefined;
  /** A bot's face. */
  face: SpadeAvatar | undefined;
  machine: string | undefined;
  elapsed: ReactNode;
  /** Open: an ace agent's thread link, or a button for a bot's chat. */
  open: ReactNode;
  /** Shown while it waits on the person: brings its request into view, else opens it. */
  onReview: (() => void) | undefined;
}

const tones: Record<SpadeSubagentRowView["tone"], string> = {
  "needs-you": "text-(--status-needs-you-text)",
  failed: "text-(--status-failed-text)",
  working: "text-foreground",
  settled: "text-muted-foreground",
  stale: "text-muted-foreground",
};

/** Open, as a quiet word at the row's end; shared by a thread link and a bot's button. */
export const openWord =
  "inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground focus-ring";

/** What the card itself needs of each agent: its state and when it ran. */
export interface SpadeSubagentSpan {
  id: string;
  state: SubagentState;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
}

export function SpadeSubagentCard(props: {
  botName: string;
  face: SpadeAvatar | undefined;
  agents: readonly SpadeSubagentSpan[];
  /** What the card reads is current: only then may it say the agents finished. */
  current: boolean;
  /** The row of the agent at `at`, a `SpadeSubagentRow`. */
  renderRow: (at: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const states = props.agents.map((agent) => agent.state);
  const header = spadeSubagentHeader(props.botName, states, {
    current: props.current,
    span: spadeSubagentsSpan(props.agents),
  });
  const { shown, hidden } = spadeShownSubagents(states, open);
  const folds = open || hidden > 0;
  const waiting = props.current && states.includes("human");
  return (
    <section
      {...part("card", waiting ? "waiting" : undefined, "spade-subagents")}
      aria-label={header}
      className="@container/card flex w-full max-w-150 min-w-0 flex-col gap-3 rounded-(--chat-bubble-radius) bg-chat-bubble px-(--chat-bubble-x) py-4"
    >
      <header className="flex min-w-0 items-start gap-2.5 font-prose text-prose leading-[1.5]">
        {props.face && <SpadeFace avatar={props.face} size={24} className="mt-px" />}
        <h3 className="min-w-0 flex-1 font-medium text-foreground">{header}</h3>
      </header>
      <ul aria-label="Agents" className="flex min-w-0 flex-col gap-1">
        {shown.map((at) => (
          <Fragment key={props.agents[at]?.id ?? at}>{props.renderRow(at)}</Fragment>
        ))}
      </ul>
      {folds && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="-my-1 ml-6.5 w-fit rounded-full px-2 py-1 text-ui text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground focus-ring"
        >
          {open ? "Show fewer" : `and ${hidden} more`}
        </button>
      )}
    </section>
  );
}

export function SpadeSubagentRow(props: { row: SpadeSubagentRowView }) {
  const { row } = props;
  const needs = row.tone === "needs-you";
  return (
    <li
      data-worker={row.id}
      data-subagent-state={row.state}
      className={cn(
        "flex min-w-0 items-center gap-2.5 py-1.5",
        // Waiting on the person: raised in place, as Spade raises what needs them.
        needs && "-mx-3 my-1 rounded-xl bg-chat-raised px-3 py-2.5 shadow-chat-raised",
      )}
    >
      <Mark row={row} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5 text-ui leading-5">
          <span className="truncate font-medium text-foreground">{row.title}</span>
          {row.machine && <span className="shrink-0 text-subtle-foreground">on {row.machine}</span>}
        </p>
        <p className="truncate text-ui leading-5 text-muted-foreground">
          <span className={tones[row.tone]}>{row.stateWords}</span>
          {row.step && <span> · {row.step}</span>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {row.elapsed && (
          <span className="px-1 text-xs text-subtle-foreground tabular-nums">{row.elapsed}</span>
        )}
        {needs && row.onReview && (
          <CardSecondary
            aria-label={`Review what ${row.title} needs`}
            data-worker-review=""
            className="h-7 px-3"
            onClick={row.onReview}
          >
            Review
          </CardSecondary>
        )}
        {row.open}
      </div>
    </li>
  );
}

/** A bot's face, or an ace agent's provider mark, quiet; the name beside it says who it is. */
function Mark(props: { row: SpadeSubagentRowView }) {
  const { row } = props;
  return (
    <span aria-hidden className="grid size-6 shrink-0 place-items-center text-muted-foreground">
      {row.kind === "bot" && row.face ? (
        <SpadeFace avatar={row.face} size={22} />
      ) : row.provider ? (
        <ProviderIcon provider={row.provider} size={14} variant="mono" decorative />
      ) : (
        <span className="size-1.5 rounded-full bg-current" />
      )}
    </span>
  );
}
