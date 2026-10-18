import {
  agentResult,
  agentStep,
  agentWorkState,
  formatSpan,
  isRunning,
  pluralCount,
} from "@ace/ui-core";
import { useAgent, useItem, useThreadMeta } from "@ace/client-react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { use } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { useNow } from "@/lib/time.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { agentMark } from "./agent-status.tsx";
import { useAgentIdentity } from "./agent-identity.ts";
import { StopAgent } from "./stop-agent.tsx";
import {
  capsule,
  CapsuleBadge,
  CapsuleGlyph,
  CapsuleMeta,
  stateWords,
  type CapsuleState,
} from "./task-capsule.tsx";
import { RowFacts, Tree } from "./tree-state.ts";
import { TreeWorkContext } from "./tree-work-context.ts";

/**
 * One agent in the tree: its name (an unnamed subagent goes by its task), the task in one line
 * when its name doesn't already say it, and what it is doing in plain words ("editing
 * work-side.tsx", "waiting on approval"). Once finished, the first line of its result and how
 * many files it changed, with Open and Diff.
 */
export function AgentRow(props: {
  threadId: string;
  agentId: string;
  depth: number;
  /** Has subagents: whether they show. */
  expanded: boolean | undefined;
  /** The id of the group of subagents it shows. */
  owns: string | undefined;
  subagents: number;
}) {
  const tree = use(Tree);
  const facts = use(RowFacts);
  const agent = useAgent(props.threadId, props.agentId);
  const thread = useThreadMeta(props.threadId);
  const openSubagent = useOpenSubagent();
  const workspace = useWorkspaceActions(props.threadId);
  const work = use(TreeWorkContext);
  const live = useLiveConnection();
  const identity = useAgentIdentity(props.threadId, agent);
  const status = agent?.status;
  const tool = useItem(
    props.threadId,
    status?.state === "working" && status.itemId ? status.itemId : "",
  );
  const now = useNow();
  if (!agent || !status) return null;
  const root = agent.origin === "root";
  const { name, task } = identity;
  const { running, needsYou, label, activity } = agentWorkState(agent, work, {
    fresh: live.fresh,
    toolTitle: tool?.type === "tool_call" ? tool.call.title : undefined,
  });
  const end = agent.endedAt ?? (running ? Math.max(now, agent.createdAt) : agent.createdAt);
  const mark = agentMark(status, running, needsYou);
  const state: CapsuleState = mark === "spinner" ? "working" : mark;
  const files = facts.files.get(agent.id) ?? [];
  const finished = state === "done";
  const result = finished ? agentResult(identity.spawn) : undefined;
  // What it is doing in plain words while it runs; how it ended once it has.
  const current = () =>
    agentStep({ status, item: tool, interaction: facts.requests.get(agent.id) });
  const step =
    !live.fresh && running
      ? activity
      : needsYou
        ? current()
        : running
          ? // Its own turn is over while work under it runs: "Waiting on work".
            isRunning(agent)
            ? current()
            : activity
          : finished
            ? (result ?? stateWords.done)
            : (stateWords[state] ?? activity);
  const meta = finished && files.length ? `${step} · ${pluralCount(files.length, "file")}` : step;
  // The main agent's time is the thread's own, which the turn already counts.
  const elapsed = !root && end - agent.createdAt >= 1000 ? formatSpan(agent.createdAt, end) : "";
  const showTask = !root && task !== undefined && task !== name;
  const open = () => {
    if (!root)
      openSubagent({
        threadId: props.threadId,
        agentId: agent.id,
        childThreadId: agent.childThreadId,
      });
  };
  return (
    <div className={cn("group/agent flex flex-wrap items-center gap-1", capsule)}>
      {/* The row is the tree item: Enter or a click opens the agent as the whole chat; a click on
          its chevron, or anywhere on the main agent (which opens nothing), folds its subagents. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- Enter opens it through the tree's key handler (treeKeys) */}
      <div
        role="treeitem"
        data-agent={agent.id}
        aria-level={props.depth + 1}
        aria-expanded={props.expanded}
        aria-owns={props.owns}
        aria-label={`${root ? "Main agent" : name}: ${label}`}
        aria-description={root ? undefined : `Opens ${name}`}
        tabIndex={tree.active === agent.id ? 0 : -1}
        onFocus={() => tree.setActive(agent.id)}
        onClick={(event) => {
          const onChevron =
            event.target instanceof Element && event.target.closest("[data-capsule-fold]");
          if (props.expanded !== undefined && (root || onChevron))
            return tree.fold(agent.id, !props.expanded);
          open();
        }}
        className={cn(
          "focus-ring-inset relative flex min-h-8 min-w-0 flex-1 items-start gap-2 rounded-md py-1.5 pr-0.5 pl-2 text-left text-ui",
          (!root || props.expanded !== undefined) && "cursor-pointer",
        )}
      >
        <span className="flex h-5 shrink-0 items-center">
          <CapsuleGlyph state={state} count={running ? props.subagents : undefined} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span className="min-w-0 shrink truncate font-medium">{name}</span>
            {needsYou && <CapsuleBadge state={state}>Needs you</CapsuleBadge>}
            <span className="flex-1" />
            {elapsed && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{elapsed}</span>
            )}
            <ProviderIconTip
              provider={agent.native.provider}
              acpAgentId={agent.native.acpAgentId}
              className="shrink-0"
            />
          </span>
          {showTask && (
            <span className="min-w-0 truncate text-xs text-subtle-foreground" title={task}>
              {task}
            </span>
          )}
          <CapsuleMeta>{meta}</CapsuleMeta>
        </span>
        <CapsuleChevron expanded={props.expanded} opens={!root} />
      </div>
      {finished && !root && (
        <span className="mr-0.5 hidden items-center gap-0.5 group-focus-within/agent:inline-flex group-hover/agent:inline-flex pointer-coarse:inline-flex">
          <Button
            size="sm"
            variant="ghost"
            tabIndex={-1}
            aria-label={`Open ${name}`}
            onClick={open}
          >
            Open
          </Button>
          {files.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              tabIndex={-1}
              aria-label={`Diff of ${name}`}
              onClick={() =>
                workspace.open({ kind: "changes", data: { scope: "last", path: files[0] } })
              }
            >
              Diff
            </Button>
          )}
        </span>
      )}
      {running && !root && thread && (
        <StopAgent
          threadId={props.threadId}
          agent={agent}
          subagents={props.subagents}
          pending={running}
          inTree
          className="mr-0.5 hidden group-focus-within/agent:inline-flex group-hover/agent:inline-flex pointer-coarse:inline-flex"
          onKeyDown={(event) => {
            // Back to the row it belongs to.
            if (event.key === "Escape" || event.key === "ArrowLeft") {
              event.preventDefault();
              event.currentTarget.parentElement
                ?.querySelector<HTMLElement>('[role="treeitem"]')
                ?.focus();
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * A capsule's chevron, drawn inside its tree item, whose click handles it: ⌄ on an agent with
 * subagents folds them (as ← → do), › on one that opens as its own tab.
 */
export function CapsuleChevron(props: { expanded: boolean | undefined; opens: boolean }) {
  if (props.expanded === undefined && !props.opens) return null;
  const Glyph = props.expanded === undefined ? CaretRightIcon : CaretDownIcon;
  return (
    <span
      aria-hidden
      data-capsule-fold={props.expanded === undefined ? undefined : ""}
      className={cn(
        "grid size-6 shrink-0 place-items-center self-start rounded-sm text-muted-foreground hover:text-foreground",
        // An opening › is a hint, not state: it shows with the row's hover or focus.
        props.expanded === undefined &&
          "opacity-0 group-focus-within/agent:opacity-100 group-hover/agent:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      <Glyph
        size={14}
        className={cn(
          "transition-transform duration-(--motion-base) ease-spring",
          props.expanded === false && "-rotate-90",
        )}
      />
    </span>
  );
}
