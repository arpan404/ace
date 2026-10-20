import {
  agentOutcome,
  agentPullRequest,
  agentStep,
  agentWorkState,
  endedByRestart,
  formatSpan,
  isRunning,
  pluralCount,
} from "@ace/ui-core";
import { useAgent, useItem, useThreadMeta } from "@ace/client-react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { use } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { cn } from "@/lib/cn.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { useNow } from "@/lib/time.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { agentMark } from "./agent-status.tsx";
import { useAgentDetails } from "./agent-details.ts";
import { useAgentIdentity } from "./agent-identity.ts";
import { PrChip } from "./pr-chip.tsx";
import { StopAgent } from "./stop-agent.tsx";
import {
  capsule,
  CapsuleBadge,
  CapsuleGlyph,
  stateWords,
  type CapsuleState,
} from "./task-capsule.tsx";
import { RowFacts, Tree } from "./tree-state.ts";
import { TreeWorkContext } from "./tree-work-context.ts";

/**
 * One agent in the tree, on one line: its glyph, its name (an unnamed subagent goes by its task),
 * then what it is doing in plain words with how long it has run ("running bun run test · 8m"),
 * or once finished the first line of its result. The pull request it opened sits at the end.
 * An agent a provider ran again is one row in its latest state; its earlier runs fold under it.
 */
export function AgentRow(props: {
  threadId: string;
  agentId: string;
  depth: number;
  /** Has subagents or earlier runs: whether they show. */
  expanded: boolean | undefined;
  /** The id of the group of subagents it shows. */
  owns: string | undefined;
  subagents: number;
  /** An earlier run of the agent on the row above: its history, not its state. */
  earlierRun?: boolean | undefined;
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
  const details = useAgentDetails(thread, agent);
  const earlier = facts.earlier.get(props.agentId) ?? [];
  // A resumed agent's first run was started by the call that reports back on it.
  const firstSpawn = useItem(props.threadId, earlier[0]?.spawnedBy ?? "");
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
  const result = finished ? agentOutcome(identity.spawn) : undefined;
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
  // The main agent's time is the thread's own, which the status line already counts.
  const elapsed =
    running && !root && end - agent.createdAt >= 1000 ? formatSpan(agent.createdAt, end) : "";
  // A note on an agent that ran more than once: short on the row, whole in its tooltip.
  const restarted = earlier.some(endedByRestart);
  const note = props.earlierRun
    ? "Earlier run"
    : restarted
      ? "resumed"
      : earlier.length
        ? `ran ${pluralCount(earlier.length + 1, "time")}`
        : "";
  const noteTip = restarted ? "Resumed after a restart" : undefined;
  // An earlier run says how it ended, in its own words when it failed.
  const ended = props.earlierRun && status.state === "failed" ? status.error.message : undefined;
  const meta = [ended ?? step, finished && files.length ? pluralCount(files.length, "file") : ""]
    .filter(Boolean)
    .join(" · ");
  const pr = props.earlierRun
    ? undefined
    : agentPullRequest([identity.spawn, firstSpawn], facts.prs);
  const showTask = !root && task !== undefined && task !== name;
  const settled = !running && !needsYou;
  const open = () => {
    if (!root)
      openSubagent({
        threadId: props.threadId,
        agentId: agent.id,
        childThreadId: agent.childThreadId,
      });
  };
  return (
    <div className={cn("group/agent flex items-center gap-1", capsule)}>
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
        title={[showTask ? `${name}\n${task}` : name, ...details.lines].join("\n")}
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
          "focus-ring-inset relative flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pr-0.5 pl-2 text-left text-ui",
          (!root || props.expanded !== undefined) && "cursor-pointer",
        )}
      >
        <CapsuleGlyph state={state} count={running ? props.subagents : undefined} />
        <ProviderAccountIcon
          provider={agent.native.provider}
          acpAgentId={agent.native.acpAgentId}
          instance={details.instance}
          size={14}
          tooltip={false}
          className={cn(settled && "opacity-70")}
        />
        <span
          className={cn(
            "max-w-[60%] min-w-0 shrink-0 truncate font-medium",
            props.earlierRun && "font-normal text-muted-foreground",
          )}
        >
          {props.earlierRun ? note : name}
        </span>
        {needsYou && <CapsuleBadge state={state}>Needs you</CapsuleBadge>}
        <span className="flex min-w-0 flex-1 items-center gap-1 text-xs">
          <span className="min-w-0 truncate text-muted-foreground" title={meta || undefined}>
            {meta}
          </span>
          {elapsed && (
            // How long it has run stays in view while what it is doing truncates.
            <span className="shrink-0 text-subtle-foreground tabular-nums">
              {meta ? "· " : ""}
              {elapsed}
            </span>
          )}
        </span>
        {note && !props.earlierRun && (
          <span
            title={noteTip}
            className="hidden shrink-0 text-xs text-subtle-foreground @[22rem]/summary:inline"
          >
            {note}
          </span>
        )}
        {details.model && !props.earlierRun && (
          <span className="hidden shrink-0 text-xs text-subtle-foreground @[26rem]/summary:inline">
            {details.model}
          </span>
        )}
        {pr && <PrChip pr={pr} />}
        <CapsuleChevron expanded={props.expanded} opens={!root} />
      </div>
      {finished && !root && !props.earlierRun && (
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
 * subagents or earlier runs folds them (as ← → do), › on one that opens as its own tab.
 */
export function CapsuleChevron(props: { expanded: boolean | undefined; opens: boolean }) {
  if (props.expanded === undefined && !props.opens) return null;
  const Glyph = props.expanded === undefined ? CaretRightIcon : CaretDownIcon;
  return (
    <span
      aria-hidden
      data-capsule-fold={props.expanded === undefined ? undefined : ""}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-sm text-faint-foreground hover:text-foreground",
        // An opening › is a hint, not state: it shows with the row's hover or focus.
        props.expanded === undefined &&
          "opacity-0 group-focus-within/agent:opacity-100 group-hover/agent:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      <Glyph
        size={14}
        className={cn(
          "transition-transform duration-(--motion-base) ease-out",
          props.expanded === false && "-rotate-90",
        )}
      />
    </span>
  );
}
