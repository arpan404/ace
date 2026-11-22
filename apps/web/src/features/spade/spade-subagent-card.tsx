import { CaretRightIcon } from "@ace/icons";
import type { ProviderKind } from "@ace/protocol";
import type { SubagentState } from "@ace/ui-core";
import {
  spadeShownSubagents,
  spadeSubagentHeader,
  spadeSubagentsNeedYou,
  type SpadeAvatar,
  type SpadeSubagentLine,
} from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { Fragment, useState, type ReactNode } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import type { threadOn } from "@/lib/machine-routes.ts";
import { part } from "@/lib/suit-part.ts";
import { SpadeFace } from "./spade-face.tsx";

/*
 * The subagent card (docs/design/spade.md, "Workers it started"): the agents one call of a bot
 * started, on the bot's bubble fill with no edge or lift, as the bot's own output, padded and
 * rounded as the question card is. Its first line is the bot's face and one sentence, with the
 * agents' time and, when one waits on the person, "1 needs you" on the right. Under it, on the
 * same text edge, one flat row per agent, hairlines between them that start at the text: its
 * mark, its name in words, a second line that says something, its time and a quiet caret. The
 * whole row opens the agent; one waiting on the person also offers Review. Past five rows the
 * rest fold into "and 3 more". A Suit reaches it as `card` `spade-subagents`.
 */

/** Where a row goes: an ace agent's thread (a link) or a bot's chat (a button). */
export type SpadeSubagentOpen =
  | { kind: "link"; to: ReturnType<typeof threadOn> }
  | { kind: "button"; onOpen: () => void };

/** One agent as its row shows it; what it says comes from `@ace/ui-core/spade-chat`. */
export interface SpadeSubagentRowView {
  id: string;
  kind: "ace" | "bot";
  /** Its name in words (`spadeSubagentName`). */
  name: string;
  state: SubagentState;
  /** Its second line, or the stale word while what the card reads isn't current. */
  line: SpadeSubagentLine | { text: string; tone: "stale"; live: false };
  /** An ace agent's provider, for its mark. */
  provider: ProviderKind | undefined;
  /** A bot's face. */
  face: SpadeAvatar | undefined;
  machine: string | undefined;
  elapsed: ReactNode;
  open: SpadeSubagentOpen | undefined;
  /** Shown while it waits on the person: brings its request into view, else opens it. */
  onReview: (() => void) | undefined;
}

const tones: Record<SpadeSubagentRowView["line"]["tone"], string> = {
  "needs-you": "text-(--status-needs-you-text)",
  failed: "text-(--status-failed-text)",
  working: "text-muted-foreground",
  settled: "text-muted-foreground",
  stale: "text-muted-foreground",
};

/** A quiet word that acts: "Review", "and 3 more". */
const quietWord =
  "rounded-full px-2 py-0.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground focus-ring";

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
  /** How long the agents have run together, beside the first line. */
  elapsed: ReactNode;
  /** The row of the agent at `at`, a `SpadeSubagentRow`. */
  renderRow: (at: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const states = props.agents.map((agent) => agent.state);
  const header = spadeSubagentHeader(props.botName, states, { current: props.current });
  const needYou = props.current ? spadeSubagentsNeedYou(states) : undefined;
  const { shown, hidden } = spadeShownSubagents(states, open);
  return (
    <section
      {...part("card", needYou ? "waiting" : undefined, "spade-subagents")}
      aria-label={header}
      // The question card's shape: its radius, its 20px padding (16 under a finger), its width.
      className="@container/card flex w-full max-w-150 min-w-0 flex-col gap-3 rounded-(--chat-bubble-radius) bg-chat-bubble p-5 pointer-coarse:p-4"
    >
      <header className="flex min-w-0 items-start gap-3 font-prose text-prose leading-[1.5]">
        {props.face && <SpadeFace avatar={props.face} size={24} className="mt-px" />}
        <h3 className="min-w-0 flex-1 font-medium text-foreground">{header}</h3>
        <span className="mt-0.5 flex shrink-0 items-baseline gap-2 text-ui tabular-nums">
          {needYou && <span className="text-(--status-needs-you-text)">{needYou}</span>}
          {props.elapsed && <span className="text-subtle-foreground">{props.elapsed}</span>}
        </span>
      </header>
      <ul aria-label="Agents" className="flex min-w-0 flex-col">
        {shown.map((at) => (
          <Fragment key={props.agents[at]?.id ?? at}>{props.renderRow(at)}</Fragment>
        ))}
      </ul>
      {(open || hidden > 0) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          // On the rows' text edge: the face's 24px and the 12px gap, less its own padding.
          className={cn(quietWord, "-mt-1 ml-7 w-fit")}
        >
          {open ? "Show fewer" : `and ${hidden} more`}
        </button>
      )}
    </section>
  );
}

/** The hairline above every row but the first, starting at the text (the mark's 24px and gap). */
const hairline =
  "not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-9 not-first:before:h-px not-first:before:bg-border-strong";

export function SpadeSubagentRow(props: { row: SpadeSubagentRowView }) {
  const { row } = props;
  const label = `Open ${row.name}${row.machine ? ` on ${row.machine}` : ""}`;
  // The whole row opens the agent: its opener covers the row, under Review.
  const opener = "absolute inset-0 rounded-lg focus-ring";
  return (
    <li
      data-worker={row.id}
      data-subagent-state={row.state}
      className={cn("group/row relative min-w-0", hairline)}
    >
      <div className="relative -mx-2 flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-2 py-1 transition-colors duration-(--motion-fast) group-hover/row:bg-hover">
        {row.open?.kind === "link" ? (
          <Link {...row.open.to} aria-label={label} className={opener} />
        ) : row.open ? (
          <button type="button" aria-label={label} className={opener} onClick={row.open.onOpen} />
        ) : null}
        <Mark row={row} />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-baseline gap-1.5 text-base leading-5">
            <span className="truncate font-medium text-foreground">{row.name}</span>
            {row.machine && (
              <span className="shrink-0 text-ui text-subtle-foreground">on {row.machine}</span>
            )}
          </p>
          <p
            // A new phrase sweeps once in the step's light, as the chat's Working line does.
            key={row.line.live ? row.line.text : undefined}
            className={cn(
              "truncate text-ui leading-[18px]",
              tones[row.line.tone],
              row.line.live && "step-shimmer",
            )}
          >
            {row.line.text}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {row.elapsed && (
            <span className="text-xs text-subtle-foreground tabular-nums">{row.elapsed}</span>
          )}
          {row.onReview && (
            <button
              type="button"
              aria-label={`Review what ${row.name} needs`}
              data-worker-review=""
              // Above the row's opener, so it takes its own clicks.
              className={cn(quietWord, "relative z-10 text-foreground")}
              onClick={row.onReview}
            >
              Review
            </button>
          )}
          {row.open && (
            <CaretRightIcon
              aria-hidden
              size={14}
              className="shrink-0 text-subtle-foreground transition-colors duration-(--motion-fast) group-hover/row:text-foreground"
            />
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * A bot's face, or an ace agent's provider mark in its own colours, as ace draws it everywhere,
 * centred on the first line. While it works it breathes a few times, then holds still
 * (`.fx-live-dot`, none under reduced motion).
 */
function Mark(props: { row: SpadeSubagentRowView }) {
  const { row } = props;
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-5 w-6 shrink-0 place-items-center self-start",
        row.state === "working" && "fx-live-dot",
      )}
    >
      {row.kind === "bot" && row.face ? (
        <SpadeFace avatar={row.face} size={18} />
      ) : row.provider ? (
        <ProviderIcon provider={row.provider} size={16} decorative />
      ) : (
        <span className="size-1.5 rounded-full bg-muted-foreground" />
      )}
    </span>
  );
}
