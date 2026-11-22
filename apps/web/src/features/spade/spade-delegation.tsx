import type { ThreadReader } from "@ace/client";
import type { AgentStatus } from "@ace/protocol";
import { useThread } from "@ace/client-react";
import { formatSpan, messageText, subagentRunning } from "@ace/ui-core";
import {
  spadeSubagentLine,
  spadeSubagentName,
  spadeSubagentsSpan,
  spadeTogetherHeader,
  spadeTogetherRows,
  spadeTogetherSpan,
  spadeTogetherState,
  type SpadeAvatar,
  type SpadeTogetherPart,
  type SpadeTogetherRow,
} from "@ace/ui-core/spade-chat";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useContext, type ReactNode } from "react";
import { SubagentElapsed, subagentDetailLine } from "@/features/thread/index.ts";
import { useLive } from "@/lib/live-connection.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { CardFace } from "./spade-card.tsx";
import { SpadeTalkRow, type SpadeTalkContext } from "./spade-talk-row.tsx";
import {
  SpadeSubagentCard,
  SpadeSubagentRow,
  type SpadeSubagentOpen,
  type SpadeSubagentSpan,
} from "./spade-subagent-card.tsx";
import {
  firstLine,
  useBotMachine,
  useSpadeWorkers,
  type SpadeWorkerEntry,
} from "./use-spade-workers.ts";

/*
 * Everything one turn of a bot did with other bots and agents (ADR 0161, ADR 0127, ADR 0200 §7)
 * as Spade's subagent card (`SpadeSubagentCard`, `spadeTogether`): the bot's face and one
 * sentence with the turn's time, then a row per thing it did. An agent or bot it started reads
 * its state in words and what it does now, its time while it runs, and opens its thread (on its
 * machine) or the bot's chat; one that waits on the person shows Review, which goes to its
 * request where the chat waits on it (`SpadeWaitingWorkers`), else opens it. A message it sent
 * another bot, or a contract it called, reads what came back and opens in place to the exchange
 * (`SpadeTalkRow`).
 */

/** The anchor of a waiting worker's request at the chat's end. */
export const workerRequestAnchor = (id: string) => `[data-worker-request="${CSS.escape(id)}"]`;

/** Bring a waiting worker's request into view and to the keyboard; false while there is none. */
export function showWorkerRequest(id: string): boolean {
  const card = document.querySelector<HTMLElement>(workerRequestAnchor(id));
  if (!card?.firstElementChild) return false;
  card.scrollIntoView?.({ block: "center", behavior: "smooth" });
  card.focus({ preventScroll: true });
  return true;
}

export interface WorkerHandlers {
  /** The bot whose workers these are. */
  bot: string;
  face(id: string): SpadeAvatar;
  onOpenBot: ((id: string) => void) | undefined;
  /** What the rows of messages and contract calls read; without it they don't show. */
  talk?: SpadeTalkContext | undefined;
}

/**
 * `children` under the bot's machine's client, so an ace agent on another machine reads and
 * opens there. While that machine can't be reached (`reachable` false) nothing of its threads is
 * read, and the tree's last word stands alone.
 */
export function OnBotMachine(props: { children: (reachable: boolean) => ReactNode }) {
  const machine = useBotMachine();
  if (!machine || machine.primary) return props.children(true);
  return (
    <MachineScope machine={machine} unavailable={props.children(false)}>
      {props.children(true)}
    </MachineScope>
  );
}

export function SpadeDelegation(props: {
  /** The turn's started workers, messages and contract calls (`spadeTogether`). */
  parts: readonly SpadeTogetherPart[];
  at: number | undefined;
  /** The bot's name, for the card's first line. */
  botName: string;
  handlers: WorkerHandlers;
}) {
  return <OnBotMachine>{(reachable) => <Card {...props} reachable={reachable} />}</OnBotMachine>;
}

function Card(props: {
  parts: readonly SpadeTogetherPart[];
  at: number | undefined;
  botName: string;
  handlers: WorkerHandlers;
  reachable: boolean;
}) {
  const workers = props.parts.flatMap((part) => (part.kind === "workers" ? part.workers : []));
  const { entries, fresh } = useSpadeWorkers(
    props.handlers.bot,
    workers,
    props.at ?? 0,
    props.reachable,
  );
  const face = useContext(CardFace);
  const talk = props.handlers.talk;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // Each row with what the card reads of it: a worker's live entry, a message's or a call's own.
  const rows = spadeTogetherRows(props.parts).flatMap((row): CardRow[] => {
    if (row.kind === "worker") {
      const entry = byId.get(row.worker.id);
      const span: SpadeSubagentSpan = entry ?? { id: row.key, state: "working" };
      return entry ? [{ row, entry, span }] : [];
    }
    if (!talk) return [];
    return [
      {
        row,
        entry: undefined,
        span: { id: row.key, state: spadeTogetherState(row), ...spadeTogetherSpan(row) },
      },
    ];
  });
  const spans = rows.map((each) => each.span);
  const span = spadeSubagentsSpan(spans);
  const workersOnly = rows.every((each) => each.row.kind === "worker");
  const header =
    workersOnly || !talk
      ? undefined
      : spadeTogetherHeader(
          props.botName,
          rows.map(({ row, entry }) => ({
            name: entry
              ? spadeSubagentName(entry.title, props.botName)
              : row.kind === "message"
                ? talkName(talk, row.bot)
                : row.kind === "contract"
                  ? row.call.bot
                  : "",
            ace: entry?.kind === "ace",
            state: entry?.state ?? (row.kind === "worker" ? "working" : spadeTogetherState(row)),
          })),
          { current: fresh, workersOnly: false },
        );
  const running = spans.some((each) => subagentRunning(each.state));
  return (
    <div className="w-full max-w-150 min-w-0">
      <SpadeSubagentCard
        botName={props.botName}
        face={face}
        agents={spans}
        current={fresh}
        header={header}
        elapsed={
          fresh &&
          span && (
            <AgentTime
              startedAt={span.startedAt}
              endedAt={span.endedAt}
              running={running}
              fresh={fresh}
            />
          )
        }
        renderRow={(at) => {
          const each = rows[at];
          if (!each) return null;
          if (each.entry)
            return (
              <WorkerRow
                entry={each.entry}
                botName={props.botName}
                fresh={fresh}
                handlers={props.handlers}
                reachable={props.reachable}
              />
            );
          return (
            talk &&
            each.row.kind !== "worker" && (
              <SpadeTalkRow
                row={each.row}
                context={talk}
                elapsed={
                  each.span.startedAt !== undefined && (
                    <AgentTime
                      startedAt={each.span.startedAt}
                      endedAt={undefined}
                      running
                      fresh={fresh}
                    />
                  )
                }
              />
            )
          );
        }}
      />
    </div>
  );
}

/** A row of the card, with what it reads: a worker's live entry, else its own span. */
interface CardRow {
  row: SpadeTogetherRow;
  entry: SpadeWorkerEntry | undefined;
  span: SpadeSubagentSpan;
}

/** A bot named by id or by name, as its name. */
function talkName(talk: SpadeTalkContext, ref: string): string {
  return talk.names.get(ref) ?? ref;
}

/** An ace agent's latest words and what its root agent does now, read from its thread. */
function useAgentWords(threadId: string | undefined) {
  const tail = useThread(threadId, ["order", "thread"], readTail, sameTail);
  const keys = tail ? [...tail.ids.map((id) => `item:${id}` as const), ...tail.agentKeys] : [];
  const read = useCallback(
    (reader: ThreadReader) => {
      const root = reader.thread?.rootAgentId;
      const agent = root ? reader.agent(root) : undefined;
      let line: string | undefined;
      const ids = tail?.ids ?? [];
      for (let at = ids.length - 1; at >= 0; at--) {
        const item = reader.item(ids[at] ?? "");
        if (item?.type !== "message" || item.role !== "assistant" || item.synthetic) continue;
        line = firstLine(messageText(item));
        if (line) break;
      }
      return { line, root, status: agent?.status };
    },
    [tail],
  );
  return useThread(tail ? threadId : undefined, keys, read, sameWords);
}

/** How far back a row looks for its agent's latest words. */
const tailItems = 40;

function readTail(reader: ThreadReader) {
  const root = reader.thread?.rootAgentId;
  return {
    ids: reader.order.slice(-tailItems),
    agentKeys: root ? [`agent:${root}` as const] : [],
  };
}

const sameTail = (a: ReturnType<typeof readTail>, b: ReturnType<typeof readTail>) =>
  a.ids.length === b.ids.length &&
  a.ids.every((id, at) => id === b.ids[at]) &&
  a.agentKeys[0] === b.agentKeys[0];

interface Words {
  line: string | undefined;
  root: string | undefined;
  status: AgentStatus | undefined;
}

const sameWords = (a: Words, b: Words) =>
  a.line === b.line && a.root === b.root && a.status === b.status;

function WorkerRow(props: {
  entry: SpadeWorkerEntry;
  botName: string;
  fresh: boolean;
  handlers: WorkerHandlers;
  reachable: boolean;
}) {
  const { entry, handlers } = props;
  const live = useLive(props.fresh);
  const navigate = useNavigate();
  const words = useAgentWords(entry.kind === "ace" && props.reachable ? entry.id : undefined);
  // An ace agent's step as ace says it for a delegated child, else the last thing it said.
  const detail =
    entry.kind === "ace"
      ? (subagentDetailLine(
          live,
          { ...entry, agentId: words?.root, result: words?.line },
          words?.status ? { status: words.status } : undefined,
          undefined,
        ).detail ?? words?.line)
      : undefined;
  const open: SpadeSubagentOpen | undefined =
    entry.kind === "ace"
      ? { kind: "link", to: threadOn(entry.machineHost, entry.id) }
      : handlers.onOpenBot
        ? { kind: "button", onOpen: () => handlers.onOpenBot?.(entry.id) }
        : undefined;
  return (
    <SpadeSubagentRow
      row={{
        id: entry.id,
        kind: entry.kind,
        name: spadeSubagentName(entry.title, props.botName),
        state: entry.state,
        // Only what is current says a state; else the connection's word stands in for it.
        line: live.current
          ? spadeSubagentLine({ ...entry, detail })
          : { text: live.word, tone: "stale", live: false },
        provider: entry.provider,
        face: entry.kind === "bot" ? handlers.face(entry.id) : undefined,
        machine: entry.machine,
        // Its time while it runs; the card's first line holds the turn's time.
        elapsed: live.current && subagentRunning(entry.state) && (
          <AgentTime
            startedAt={entry.startedAt}
            endedAt={entry.endedAt}
            running={subagentRunning(entry.state)}
            fresh={props.fresh}
          />
        ),
        open,
        onReview:
          live.current && entry.state === "human"
            ? () => {
                if (showWorkerRequest(entry.id)) return;
                if (entry.kind === "ace") void navigate(threadOn(entry.machineHost, entry.id));
                else handlers.onOpenBot?.(entry.id);
              }
            : undefined,
      }}
    />
  );
}

/**
 * How long an agent has run, ticking to the second while it runs (as ace's child rows do), or
 * how long it took once it ended, to the minute ("22m"): a settled time needs no seconds.
 */
function AgentTime(props: {
  startedAt: number;
  endedAt: number | undefined;
  running: boolean;
  fresh: boolean;
}) {
  if (props.running || props.endedAt === undefined) return <SubagentElapsed {...props} />;
  if (props.endedAt - props.startedAt < 1000) return null;
  return <span aria-label="Elapsed time">{formatSpan(props.startedAt, props.endedAt)}</span>;
}
