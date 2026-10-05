import { useSidebarThread, useThread, useThreadMeta } from "@ace/client-react";
import { CardsIcon, GitDiffIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useThreadDiffStat } from "@/lib/diffs/use-turns.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useCheckoutState } from "../lib/use-git.ts";
import { useTaskKeys } from "../lib/use-task-keys.ts";
import type { ThreadRef } from "../sources/index.ts";
import {
  pendingInteractions,
  runningShell,
  runningTasks,
  sameMarks,
  subagentSummary,
  subagentsOf,
  type SubagentMark,
} from "./summary-model.ts";
import { SummarySources } from "./summary-sources.tsx";

const noMarks: readonly SubagentMark[] = [];
/** More marks than this fold into "+N"; the summary line still counts them all. */
const shownMarks = 8;

const sectionLabel = "flex h-7 items-center px-2.5 text-xs font-medium text-subtle-foreground";
const rowButton =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent";

/**
 * The summary's contents: the thread's changes, its subagents (each mark opens that agent),
 * its sources, and what waits on the person (approvals, a usage limit, a Deck run, background
 * work). Every row opens the tool it summarises.
 */
export function SummaryBody(props: { thread: ThreadRef; onAddSource(): void }) {
  const id = props.thread.id;
  return (
    <div className="flex flex-col">
      <ChangesRow thread={props.thread} />
      <Subagents threadId={id} />
      <SummarySources thread={props.thread} onAdd={props.onAddSource} />
      <Extras threadId={id} />
    </div>
  );
}

/** The thread's own diff (+added −removed), with what is still uncommitted underneath. */
function ChangesRow(props: { thread: ThreadRef }) {
  const workspace = useWorkspaceActions(props.thread.id);
  const stat = useThreadDiffStat(props.thread.id);
  const { checkout, state } = useCheckoutState(props.thread);
  const edited = stat.additions + stat.deletions > 0;
  const uncommitted =
    state === "loading" ? (
      <span className="flex items-center gap-1.5">
        <Spinner /> Reading the checkout
      </span>
    ) : !checkout ? (
      "Not a git checkout"
    ) : checkout.changed > 0 ? (
      `${checkout.changed} uncommitted ${checkout.changed === 1 ? "file" : "files"}`
    ) : (
      "Nothing uncommitted"
    );
  return (
    <button
      type="button"
      aria-label={`Changes: ${edited ? `${stat.additions} added, ${stat.deletions} removed` : "no edits yet"}`}
      onClick={() => workspace.open({ kind: "changes" })}
      className={cn(rowButton, "min-h-11 py-1.5")}
    >
      <GitDiffIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex h-5 items-center gap-2 text-ui text-foreground">
          <span className="flex-1">Changes</span>
          {edited ? (
            <DiffStat {...stat} className="text-xs" />
          ) : (
            <span className="text-xs text-subtle-foreground">No edits yet</span>
          )}
        </span>
        <span className="flex h-4 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {checkout?.branch && (
            <>
              <span className="min-w-0 truncate font-mono text-[11px]">{checkout.branch}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span className="shrink-0">{uncommitted}</span>
        </span>
      </span>
    </button>
  );
}

/** A mark per subagent, each opening its own tab, then "2 running · 4 done" for the tree. */
function Subagents(props: { threadId: string }) {
  const workspace = useWorkspaceActions(props.threadId);
  const marks = useThread(props.threadId, ["agents"], subagentsOf, sameMarks) ?? noMarks;
  const extra = marks.length - shownMarks;
  return (
    <section aria-label="Subagents" className="mt-1">
      <h3 className={sectionLabel}>Subagents</h3>
      {marks.length === 0 ? (
        <p className="flex h-8 items-center px-2.5 text-xs text-subtle-foreground">
          No subagents yet
        </p>
      ) : (
        <div className="flex h-8 items-center gap-0.5 px-1.5">
          <ul aria-label="Subagents by name" className="flex shrink-0 items-center">
            {marks.slice(0, shownMarks).map((mark) => (
              <li key={mark.id}>
                <Tip label={`${mark.name} · ${mark.running ? "running" : "done"}`}>
                  <button
                    type="button"
                    aria-label={`Open ${mark.name}`}
                    onClick={() => workspace.open({ kind: "agent", id: mark.id, title: mark.name })}
                    className={cn(
                      "relative grid size-7 place-items-center rounded-md outline-none hover:bg-accent focus-visible:bg-accent",
                      mark.running ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <ProviderIcon
                      provider={mark.provider}
                      acpAgentId={mark.acpAgentId}
                      size={14}
                      decorative
                    />
                    {(mark.tone === "needs-you" || mark.tone === "failed") && (
                      <Dot tone={mark.tone} className="absolute top-1 right-1" />
                    )}
                  </button>
                </Tip>
              </li>
            ))}
          </ul>
          {extra > 0 && (
            <span className="px-1 text-xs text-subtle-foreground tabular-nums">+{extra}</span>
          )}
          <button
            type="button"
            onClick={() => workspace.open({ kind: "agents" })}
            className="ml-1 flex h-7 min-w-0 items-center truncate rounded-md px-1.5 text-xs text-muted-foreground tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
          >
            {subagentSummary(marks)}
          </button>
        </div>
      )}
    </section>
  );
}

/** ace's extras, only when present: approvals waiting, a usage limit, a Deck run, background work. */
function Extras(props: { threadId: string }) {
  const id = props.threadId;
  const workspace = useWorkspaceActions(id);
  const status = useThreadMeta(id)?.status;
  const deck = useSidebarThread(id)?.deck;
  const pending = useThread(id, ["interactions"], pendingInteractions) ?? 0;
  const taskKeys = useTaskKeys(id);
  const tasks = useThread(id, taskKeys, runningTasks) ?? 0;
  const shell = useThread(id, taskKeys, runningShell);
  const limited = status?.state === "limited";
  if (!pending && !limited && !deck && !tasks) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 border-t px-1 pt-1.5 pb-0.5">
      {pending > 0 && (
        <Chip>
          <Dot tone="needs-you" />
          {pending} waiting on you
        </Chip>
      )}
      {limited && (
        <Chip>
          <Dot tone="limited" />
          Limited · usage limit reached
        </Chip>
      )}
      {deck && (
        <Link
          to="/deck/$runId"
          params={{ runId: deck.runId }}
          className="flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
        >
          <CardsIcon aria-hidden size={12} />
          Deck run
        </Link>
      )}
      {tasks > 0 && (
        <button
          type="button"
          onClick={() =>
            workspace.open(shell ? { kind: "shell", id: shell } : { kind: "terminal" })
          }
          className="flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
        >
          <TerminalWindowIcon aria-hidden size={12} />
          {tasks} in background
        </button>
      )}
    </div>
  );
}

function Chip(props: { children: ReactNode }) {
  return (
    <span role="status" className="flex h-6 items-center gap-1.5 px-1.5 text-xs text-foreground">
      {props.children}
    </span>
  );
}
