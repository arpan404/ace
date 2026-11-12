import {
  stillRunning,
  type AgentForest,
  type AgentForestNode,
  type CommandForestNode,
  type ThreadWork,
} from "@ace/ui-core";
import type { Interaction } from "@ace/protocol";
import { useMemo, type ReactNode } from "react";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { cn } from "@/lib/cn.ts";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import {
  forestRequests,
  requestFor,
  useAgentRowFacts,
  useCommandRowFacts,
} from "./agent-row-facts.ts";
import { TaskStop } from "./summary-rows.tsx";
import { QuietLink, Section } from "./summary-section.tsx";
import { SummaryTree } from "./summary-tree.tsx";

/** Where the person's choice to show the whole agent tree is kept, with the tab's folds. */
const treeKey = "agents:all";

/** One row of the live list: its main part opens it, actions sit at its right. */
function LiveRow(props: {
  label: string;
  title?: string | undefined;
  onOpen: (() => void) | undefined;
  actions?: ReactNode;
  /** The time gives way to the row's actions on hover. */
  time: string;
  children: ReactNode;
}) {
  const body = (
    <>
      {props.children}
      {props.time && (
        <span
          className={cn(
            "ml-auto shrink-0 pl-1 text-xs text-subtle-foreground tabular-nums",
            props.actions !== undefined && "group-focus-within/row:hidden group-hover/row:hidden",
          )}
        >
          {props.time}
        </span>
      )}
    </>
  );
  const frame =
    "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-ui pointer-coarse:h-11";
  return (
    <li
      data-row-frame=""
      className="group/row flex min-w-0 flex-wrap items-center rounded-md hover:bg-accent"
    >
      {props.onOpen ? (
        <button
          type="button"
          data-row-main=""
          aria-label={props.label}
          title={props.title}
          onClick={props.onOpen}
          className={cn("focus-ring-inset", frame)}
        >
          {body}
        </button>
      ) : (
        <p data-row-main="" title={props.title} className={frame}>
          <span className="sr-only">{props.label}</span>
          <span aria-hidden className="contents">
            {body}
          </span>
        </p>
      )}
      {props.actions}
    </li>
  );
}

/**
 * An agent that works or waits: its status glyph in the state's colour, its name, what it is
 * doing in grey, how long it has run. One that asks the person reads in the needs-you colour
 * with Open to it.
 */
function LiveAgent(props: {
  node: AgentForestNode;
  viewed: string;
  request: Interaction | undefined;
}) {
  const row = useAgentRowFacts({ ...props, folded: false });
  const open = row.open;
  return (
    <LiveRow
      label={row.label}
      title={row.title}
      onOpen={open}
      time={row.time}
      actions={
        row.asking && open ? (
          <span className="mr-2 shrink-0 text-xs">
            <QuietLink strong label={`Open ${row.name}`} onClick={open}>
              Open
            </QuietLink>
          </span>
        ) : undefined
      }
    >
      <StatusGlyph state={row.glyph} still={row.stale || row.uncertain} />
      <span className="max-w-[50%] min-w-0 shrink truncate font-medium">{row.name}</span>
      <span
        data-tone={row.tone}
        className={cn(
          "min-w-0 flex-1 truncate",
          row.tone ? "text-(--tone-text)" : "text-muted-foreground",
        )}
      >
        {row.step}
      </span>
    </LiveRow>
  );
}

/** A background command still running, as `$ command`, with Stop on hover. */
function LiveCommand(props: { node: CommandForestNode; viewed: string }) {
  const row = useCommandRowFacts(props.node, props.viewed);
  const { task } = props.node;
  return (
    <LiveRow
      label={row.label}
      title={row.command}
      onOpen={row.open}
      time={row.time}
      actions={task.stoppable ? <TaskStop task={task} tabbable /> : undefined}
    >
      <span
        aria-hidden
        className="w-3.5 shrink-0 text-center font-mono text-xs text-subtle-foreground"
      >
        $
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.command}</span>
    </LiveRow>
  );
}

/**
 * Still running: only live work, flattened from the whole tree (any depth, across delegated
 * threads), with whoever needs the person first and a queued message's line on top. Under it,
 * "Show all agents (N)" opens the full agent tree in place; the choice is kept with the tab.
 */
export function StillRunning(props: {
  threadId: string;
  forest: AgentForest;
  works: ReadonlyMap<string, ThreadWork>;
  /** "1 queued message · sends when the agent is free", while one waits. */
  queued: string | undefined;
  /** How many agents the tree holds, when there is a tree beyond the main agent. */
  agents: number | undefined;
}) {
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const sections = workspace.tabs.find((tab) => tab.key === "work")?.ui?.sections;
  const showTree = sections?.[treeKey] === true;
  const rows = useMemo(
    () => stillRunning(props.forest.roots, props.threadId),
    [props.forest.roots, props.threadId],
  );
  const requests = useMemo(() => forestRequests(props.works), [props.works]);
  return (
    <>
      {(rows.length > 0 || props.queued) && (
        <Section name="Still running">
          <ul className="flex flex-col divide-y divide-border-soft rounded-lg bg-surface-1 p-1">
            {props.queued && (
              <li className="flex h-8 min-w-0 items-center gap-2 px-2 text-ui text-muted-foreground">
                <StatusGlyph state="queued" />
                <span className="min-w-0 truncate">{props.queued}</span>
              </li>
            )}
            {rows.map((node) =>
              node.kind === "agent" ? (
                <LiveAgent
                  key={node.key}
                  node={node}
                  viewed={props.threadId}
                  request={requestFor(node, requests)}
                />
              ) : (
                <LiveCommand key={node.key} node={node} viewed={props.threadId} />
              ),
            )}
          </ul>
        </Section>
      )}
      {props.agents !== undefined && (
        <section aria-label="Agents" className="flex min-w-0 flex-col gap-1">
          <p className="px-2">
            <button
              type="button"
              aria-expanded={showTree}
              onClick={() =>
                actions.updateUi("work", { sections: { ...sections, [treeKey]: !showTree } })
              }
              className="focus-ring rounded-xs text-xs text-subtle-foreground underline decoration-border underline-offset-3 hover:text-foreground"
            >
              {showTree ? "Hide agents" : `Show all agents (${props.agents})`}
            </button>
          </p>
          {showTree && (
            <SummaryTree threadId={props.threadId} roots={props.forest.roots} works={props.works} />
          )}
        </section>
      )}
    </>
  );
}
