import type { ThreadReader } from "@ace/client";
import type { AgentStatus } from "@ace/protocol";
import { useThread } from "@ace/client-react";
import { messageText, subagentRunning } from "@ace/ui-core";
import {
  spadeSubagentStateWords,
  spadeSubagentStep,
  spadeSubagentTone,
  type SpadeAvatar,
  type SpadeStartedWorker,
} from "@ace/ui-core/spade-chat";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useContext, type ReactNode } from "react";
import { SubagentElapsed, subagentDetailLine } from "@/features/thread/index.ts";
import { useLive } from "@/lib/live-connection.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { CardFace } from "./spade-card.tsx";
import { openWord, SpadeSubagentCard, SpadeSubagentRow } from "./spade-subagent-card.tsx";
import {
  firstLine,
  useBotMachine,
  useSpadeWorkers,
  type SpadeWorkerEntry,
} from "./use-spade-workers.ts";

/*
 * The bots and ace agents a bot started (ADR 0161), in the turn that started them, as Spade's
 * subagent card (`SpadeSubagentCard`): the bot's face and one sentence, then a row per worker with
 * its state in words, what it does now, how long it has run and Open, which goes to the agent's
 * thread (on its machine) or the bot's chat. One that waits on the person shows Review in its
 * row, which goes to its request where the chat waits on it (`SpadeWaitingWorkers`), else opens
 * it.
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
  workers: readonly SpadeStartedWorker[];
  at: number | undefined;
  /** The bot's name, for the card's first line. */
  botName: string;
  handlers: WorkerHandlers;
}) {
  return <OnBotMachine>{(reachable) => <Card {...props} reachable={reachable} />}</OnBotMachine>;
}

function Card(props: {
  workers: readonly SpadeStartedWorker[];
  at: number | undefined;
  botName: string;
  handlers: WorkerHandlers;
  reachable: boolean;
}) {
  const { entries, fresh } = useSpadeWorkers(
    props.handlers.bot,
    props.workers,
    props.at ?? 0,
    props.reachable,
  );
  const face = useContext(CardFace);
  return (
    <div className="w-full max-w-150 min-w-0">
      <SpadeSubagentCard
        botName={props.botName}
        face={face}
        agents={entries}
        current={fresh}
        renderRow={(at) => {
          const entry = entries[at];
          return (
            entry && (
              <WorkerRow
                entry={entry}
                fresh={fresh}
                handlers={props.handlers}
                reachable={props.reachable}
              />
            )
          );
        }}
      />
    </div>
  );
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
  const facts = { ...entry, detail };
  const label = `Open ${entry.title}${entry.machine ? ` on ${entry.machine}` : ""}`;
  const openIt = () => {
    if (entry.kind === "ace") void navigate(threadOn(entry.machineHost, entry.id));
    else handlers.onOpenBot?.(entry.id);
  };
  return (
    <SpadeSubagentRow
      row={{
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        state: entry.state,
        // Only what is current says a state; else the connection's word stands in for it.
        stateWords: live.current ? spadeSubagentStateWords(facts) : live.word,
        tone: live.current ? spadeSubagentTone(entry.state) : "stale",
        step: live.current ? spadeSubagentStep(facts) : undefined,
        provider: entry.provider,
        face: entry.kind === "bot" ? handlers.face(entry.id) : undefined,
        machine: entry.machine,
        elapsed: live.current && (
          <SubagentElapsed
            startedAt={entry.startedAt}
            endedAt={entry.endedAt}
            running={subagentRunning(entry.state)}
            fresh={props.fresh}
          />
        ),
        open:
          entry.kind === "ace" ? (
            <Link
              {...threadOn(entry.machineHost, entry.id)}
              aria-label={label}
              className={openWord}
            >
              Open
            </Link>
          ) : (
            handlers.onOpenBot && (
              <button
                type="button"
                aria-label={label}
                className={openWord}
                onClick={() => handlers.onOpenBot?.(entry.id)}
              >
                Open
              </button>
            )
          ),
        onReview: () => {
          if (!showWorkerRequest(entry.id)) openIt();
        },
      }}
    />
  );
}
