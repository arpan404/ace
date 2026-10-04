import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { agentStatusLabel, type Tone } from "@ace/ui-core";
import {
  CaretRightIcon,
  GitBranchIcon,
  ListBulletsIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { keymap, type KeymapId } from "@/lib/keymap.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useCheckoutState } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";

interface AgentCounts {
  working: number;
  needsYou: number;
  waiting: number;
  failed: number;
  done: number;
}

const countAgents = (reader: ThreadReader): AgentCounts => {
  const counts: AgentCounts = { working: 0, needsYou: 0, waiting: 0, failed: 0, done: 0 };
  const key: Record<Tone, keyof AgentCounts> = {
    working: "working",
    "needs-you": "needsYou",
    waiting: "waiting",
    failed: "failed",
    done: "done",
    idle: "done",
  };
  for (const id of reader.agentIds()) {
    const agent = reader.agent(id);
    if (agent) counts[key[agentStatusLabel(agent.status).tone]]++;
  }
  return counts;
};
const sameCounts = (a: AgentCounts, b: AgentCounts) =>
  a.working === b.working &&
  a.needsYou === b.needsYou &&
  a.waiting === b.waiting &&
  a.failed === b.failed &&
  a.done === b.done;
const runningTasks = (reader: ThreadReader) =>
  reader.taskIds().filter((id) => reader.task(id)?.status === "running").length;

/**
 * The header's summary toggle: a thread at a glance (its checkout, its agents, background work)
 * with a way into the tool for each. The opened-tab count is the dock toggle's, not this.
 */
export function ThreadSummary(props: { thread: ThreadRef }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<IconButton icon={ListBulletsIcon} label="Thread summary" pressed={open} />}
      />
      <PopoverContent align="start" className="w-[300px] p-1.5">
        <SummaryBody thread={props.thread} onPick={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function SummaryBody(props: { thread: ThreadRef; onPick(): void }) {
  const id = props.thread.id;
  const workspace = useWorkspaceActions(id);
  const { checkout, state } = useCheckoutState(props.thread);
  const agents = useThread(id, ["agents"], countAgents, sameCounts);
  const tasks = useThread(id, ["tasks"], runningTasks) ?? 0;
  const open = (kind: string) => {
    workspace.open({ kind });
    props.onPick();
  };
  const agentParts = agents
    ? [
        agents.needsYou && { tone: "needs-you" as const, text: `${agents.needsYou} need you` },
        agents.failed && { tone: "failed" as const, text: `${agents.failed} failed` },
        agents.working && { tone: undefined, text: `${agents.working} working` },
        agents.waiting && { tone: undefined, text: `${agents.waiting} waiting` },
        agents.done && { tone: undefined, text: `${agents.done} done` },
      ].filter((part) => !!part)
    : [];
  return (
    <div className="flex flex-col gap-0.5">
      <Row
        icon={GitBranchIcon}
        label="Changes"
        shortcut="changes"
        onClick={() => open("changes")}
        detail={
          state === "loading" ? (
            <span className="flex items-center gap-1.5">
              <Spinner /> Reading the checkout
            </span>
          ) : checkout ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-mono text-[11.5px]">
                {checkout.branch ?? "detached HEAD"}
              </span>
              {checkout.changed > 0 ? (
                <span className="shrink-0 font-mono text-[11px] tabular-nums">
                  <span className="text-status-done">+{checkout.additions}</span>{" "}
                  <span className="text-status-failed">−{checkout.deletions}</span>
                </span>
              ) : (
                <span className="shrink-0">clean</span>
              )}
            </span>
          ) : (
            "Not a git checkout"
          )
        }
      />
      <Row
        icon={TreeStructureIcon}
        label="Agents"
        shortcut="agents"
        onClick={() => open("agents")}
        detail={
          agentParts.length ? (
            <span className="flex min-w-0 items-center gap-2">
              {agentParts.map((part) => (
                <span key={part.text} className="flex shrink-0 items-center gap-1">
                  {part.tone && <Dot tone={part.tone} />}
                  {part.text}
                </span>
              ))}
            </span>
          ) : (
            "No agents yet"
          )
        }
      />
      <Row
        icon={TerminalWindowIcon}
        label="Background"
        shortcut="terminal"
        onClick={() => open("terminal")}
        detail={tasks ? `${tasks} running` : "Nothing running"}
      />
    </div>
  );
}

function Row(props: {
  icon: PhosphorIcon;
  label: string;
  detail: ReactNode;
  shortcut: KeymapId;
  onClick(): void;
}) {
  const Glyph = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="group/row flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
    >
      <Glyph aria-hidden size={16} className="shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-ui text-foreground">
          {props.label}
          <Kbd
            keys={keymap[props.shortcut].keys}
            className="opacity-0 group-hover/row:opacity-100"
          />
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{props.detail}</span>
      </span>
      <CaretRightIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
    </button>
  );
}
