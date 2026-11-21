import type { ThreadReader } from "@ace/client";
import type { AgentStatus } from "@ace/protocol";
import { useThread } from "@ace/client-react";
import { messageText, subagentMeta, subagentTerminal } from "@ace/ui-core";
import {
  spadeAskingWords,
  spadeWorkersTitle,
  type SpadeAvatar,
  type SpadeStartedWorker,
} from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { useCallback, useState, type ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import {
  AgentRowContents,
  agentRowStyles,
  SubagentFold,
  SubagentSection,
  subagentDetailLine,
  type AgentRowParts,
} from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useLive, type Live } from "@/lib/live-connection.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { SpadeFace } from "./spade-face.tsx";
import {
  firstLine,
  useBotMachine,
  useSpadeWorkers,
  type SpadeWorkerEntry,
} from "./use-spade-workers.ts";

/*
 * The bots and ace agents a bot started (ADR 0161), in the turn that started them, drawn with
 * ace's own child rows: one row while a lone worker runs, else one "Started 4 agents" row with
 * each state's count that opens to every row. A row is its mark (a provider's, a bot's face), its
 * name, model and machine, its state in words and its last line; it opens the agent's thread (on
 * its machine) or the bot's chat. One that waits on the person offers Review, which goes to its
 * request where the chat waits on it (`SpadeWaitingWorkers`).
 */

/** The anchor of a waiting worker's request at the chat's end. */
export const workerRequestAnchor = (id: string) => `[data-worker-request="${CSS.escape(id)}"]`;

/** Bring a waiting worker's request into view and to the keyboard. */
export function showWorkerRequest(id: string) {
  const card = document.querySelector<HTMLElement>(workerRequestAnchor(id));
  card?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  card?.focus({ preventScroll: true });
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
  handlers: WorkerHandlers;
}) {
  return <OnBotMachine>{(reachable) => <Card {...props} reachable={reachable} />}</OnBotMachine>;
}

function Card(props: {
  workers: readonly SpadeStartedWorker[];
  at: number | undefined;
  handlers: WorkerHandlers;
  reachable: boolean;
}) {
  const { entries, fresh } = useSpadeWorkers(
    props.handlers.bot,
    props.workers,
    props.at ?? 0,
    props.reachable,
  );
  const [open, setOpen] = useState(false);
  const states = entries.map((entry) => entry.state);
  const title = spadeWorkersTitle(states);
  const [only] = entries;
  const single = entries.length === 1 && only && !subagentTerminal(only.state) ? only : undefined;
  return (
    <div className="w-full max-w-150 min-w-0 px-(--chat-bubble-x)">
      <SubagentSection states={states} fresh={fresh} folded={!single} title={title}>
        {single ? (
          <ul aria-label="Workers" className="flex flex-col">
            <WorkerRow
              entry={single}
              fresh={fresh}
              handlers={props.handlers}
              reachable={props.reachable}
            />
          </ul>
        ) : (
          <SubagentFold
            entries={entries}
            fresh={fresh}
            open={open}
            onToggle={() => setOpen(!open)}
            title={title}
          >
            {entries.map((entry) => (
              <WorkerRow
                key={entry.id}
                entry={entry}
                fresh={fresh}
                handlers={props.handlers}
                reachable={props.reachable}
                listed
              />
            ))}
          </SubagentFold>
        )}
      </SubagentSection>
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

/** A row's second line and what it says (`detailKind`), from ace's words for a child's. */
function detailOf(
  entry: SpadeWorkerEntry,
  words: Words | undefined,
  live: Live,
): Pick<AgentRowParts, "detail" | "detailKind"> {
  if (!live.current) return {};
  if (entry.state === "human")
    return { detail: spadeAskingWords(entry.asking), detailKind: "human" };
  if (entry.kind === "bot")
    return subagentTerminal(entry.state)
      ? {}
      : entry.status
        ? { detail: entry.status, detailKind: "live" }
        : {};
  const shown = subagentDetailLine(
    live,
    { ...entry, agentId: words?.root, result: words?.line },
    words?.status ? { status: words.status } : undefined,
    undefined,
  );
  return { detail: shown.detail, detailKind: shown.kind };
}

function WorkerRow(props: {
  entry: SpadeWorkerEntry;
  fresh: boolean;
  handlers: WorkerHandlers;
  reachable: boolean;
  listed?: boolean | undefined;
}) {
  const { entry, handlers } = props;
  const live = useLive(props.fresh);
  const words = useAgentWords(entry.kind === "ace" && props.reachable ? entry.id : undefined);
  const parts: AgentRowParts = {
    mark: { provider: entry.provider, model: entry.model },
    lead:
      entry.kind === "bot" ? <SpadeFace avatar={handlers.face(entry.id)} size={16} /> : undefined,
    name: entry.title,
    meta: entry.kind === "ace" ? subagentMeta(entry) : "Bot",
    machine: entry.machine,
    state: entry.state,
    live,
    ...detailOf(entry, words, live),
  };
  const box = cn(agentRowStyles.box, props.listed && agentRowStyles.listed);
  const label = `Open ${entry.title}${entry.machine ? ` on ${entry.machine}` : ""}`;
  return (
    <li data-worker={entry.id} data-subagent-state={entry.state} className="relative">
      {entry.kind === "ace" ? (
        <Link {...threadOn(entry.machineHost, entry.id)} aria-label={label} className={box}>
          <AgentRowContents {...parts} />
        </Link>
      ) : (
        <button
          type="button"
          aria-label={label}
          className={box}
          onClick={() => handlers.onOpenBot?.(entry.id)}
        >
          <AgentRowContents {...parts} />
        </button>
      )}
      {live.current && entry.state === "human" && (
        <button
          type="button"
          aria-label={`Review what ${entry.title} needs`}
          onClick={() => showWorkerRequest(entry.id)}
          className={cn(
            buttonVariants({ variant: "secondary", size: "sm" }),
            "absolute right-0 bottom-1 h-5 px-2 text-xs",
          )}
        >
          Review
        </button>
      )}
    </li>
  );
}
