import { holdStoppable, type AgentForestNode, type CommandForestNode } from "@ace/ui-core";
import type { BackgroundTask, Interaction, ProviderKind } from "@ace/protocol";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { KeyboardEvent, ReactNode } from "react";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { cn } from "@/lib/cn.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useReducedMotion } from "@/lib/motion.ts";
import { StopAgent } from "../agents/stop-agent.tsx";
import { useStopIntent } from "../agents/use-stop-intent.ts";
import { useAgentRowFacts, useCommandRowFacts } from "./agent-row-facts.ts";

/** Each level of the tree steps in this far. */
export const indent = 18;
const inset = 8;

/** Where a row's children hang their guide: under the row's mark. */
export const guideLeft = (depth: number) => inset + depth * indent + 21;

/** What a row draws beside its tree semantics. */
export interface RowProps {
  depth: number;
  /** Has children: whether they show. */
  expanded: boolean | undefined;
  active: boolean;
  onFocus(): void;
  onFold(): void;
}

/** Escape or ← on a row's Stop goes back to the row it belongs to. */
export function backToRow(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
  const row = event.currentTarget
    .closest("[data-row-frame]")
    ?.querySelector<HTMLElement>('[role="treeitem"], [data-row-main]');
  if (!row) return;
  event.preventDefault();
  event.stopPropagation();
  row.focus();
}

/**
 * The tree's one status mark: the provider's own mark, in foreground ink and breathing while it
 * or anything under it works or waits, still at rest, dimmed once done. It holds still under
 * reduced motion and while the facts are stale: the connection dropped, or its thread hasn't
 * been confirmed since the Summary opened.
 */
export function LiveMark(props: {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  instance?: string | undefined;
  live: boolean;
  done: boolean;
  stale?: boolean | undefined;
}) {
  const fresh = useLiveConnection().fresh;
  const reduced = useReducedMotion();
  const breathing = props.live && fresh && !props.stale && !reduced;
  return (
    <span
      data-breathing={breathing ? "" : undefined}
      className={cn(
        "grid size-3.5 shrink-0 place-items-center",
        breathing && "fx-alive",
        props.done && "opacity-55",
      )}
    >
      <ProviderAccountIcon
        provider={props.provider}
        acpAgentId={props.acpAgentId}
        instance={props.instance}
        size={14}
        tooltip={false}
        decorative
      />
    </span>
  );
}

/** A row's frame: the caret, then its content, indented for its depth. */
function RowFrame(
  props: RowProps & {
    rowKey: string;
    label: string;
    title?: string | undefined;
    onOpen?: (() => void) | undefined;
    actions?: ReactNode;
    children: ReactNode;
  },
) {
  return (
    <div
      data-row-frame=""
      className="group/row relative flex min-w-0 flex-wrap items-center rounded-md hover:bg-accent"
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- Enter opens it through the tree's key handler */}
      <div
        role="treeitem"
        data-row={props.rowKey}
        aria-level={props.depth + 1}
        aria-expanded={props.expanded}
        aria-label={props.label}
        title={props.title}
        tabIndex={props.active ? 0 : -1}
        onFocus={props.onFocus}
        onClick={(event) => {
          const onCaret = event.target instanceof Element && event.target.closest("[data-caret]");
          if (props.expanded !== undefined && (onCaret || !props.onOpen)) return props.onFold();
          props.onOpen?.();
        }}
        style={{ paddingLeft: inset + props.depth * indent }}
        className={cn(
          "focus-ring-inset flex h-7.5 min-w-0 flex-1 items-center gap-1.75 rounded-md pr-2 text-left text-ui pointer-coarse:h-11",
          (props.onOpen || props.expanded !== undefined) && "cursor-pointer",
        )}
      >
        <span
          aria-hidden
          data-caret={props.expanded === undefined ? undefined : ""}
          className="grid size-3.5 shrink-0 place-items-center text-subtle-foreground"
        >
          {props.expanded !== undefined && (
            <CaretDownIcon
              size={12}
              className={cn(
                "transition-transform duration-(--motion-fast) ease-out",
                !props.expanded && "-rotate-90",
              )}
            />
          )}
        </span>
        {props.children}
      </div>
      {props.actions}
    </div>
  );
}

/** The time on a row's right, which gives way to its actions on hover. */
function RowTime(props: { children: string }) {
  if (!props.children) return null;
  return (
    <span className="shrink-0 text-xs text-subtle-foreground tabular-nums group-focus-within/row:hidden group-hover/row:hidden">
      {props.children}
    </span>
  );
}

/**
 * One agent: its mark, its name, what it is doing in grey (in the warning colour when it asks the
 * person, red when it failed) and how long it has run. A folded branch says what it holds.
 * A click opens the agent: a delegated thread as itself, a subagent in its thread's agent view.
 */
export function AgentLine(
  props: RowProps & {
    node: AgentForestNode;
    /** The thread the Summary shows: its own main agent opens nothing. */
    viewed: string;
    request: Interaction | undefined;
  },
) {
  const { node } = props;
  const { agent } = node;
  const below = node.tally;
  const row = useAgentRowFacts({
    node,
    viewed: props.viewed,
    request: props.request,
    folded: props.expanded === false,
  });
  return (
    <RowFrame
      {...props}
      rowKey={node.key}
      label={row.label}
      title={row.title}
      onOpen={row.open}
      actions={
        // A child on another machine stops through the work its parent holds for it.
        agent.machine ? (
          node.hold && holdStoppable(node.hold) ? (
            <TaskStop task={node.hold} />
          ) : undefined
        ) : row.own && !row.root ? (
          <StopAgent
            threadId={node.threadId}
            agent={agent}
            subagents={below.working + below.done + below.syncing}
            pending
            inTree
            variant="ghost"
            className="mr-0.5 hidden group-focus-within/row:inline-flex group-hover/row:inline-flex pointer-coarse:inline-flex"
            onKeyDown={backToRow}
          />
        ) : undefined
      }
    >
      <LiveMark
        provider={agent.native.provider}
        acpAgentId={agent.native.acpAgentId}
        instance={row.details.instance}
        live={node.live}
        done={row.done}
        stale={row.stale || row.uncertain}
      />
      <span
        className={cn(
          "max-w-[55%] min-w-0 shrink truncate font-medium",
          (row.done || row.settledLook) && "text-muted-foreground",
        )}
      >
        {row.name}
        {agent.machine && (
          <span className="font-normal text-subtle-foreground"> · {agent.machine.name}</span>
        )}
      </span>
      <span
        data-tone={row.tone}
        className={cn(
          "min-w-0 flex-1 truncate",
          row.tone ? "text-(--tone-text)" : "text-subtle-foreground",
        )}
      >
        {row.step}
        {row.folded && <span className="text-subtle-foreground"> · {row.folded}</span>}
      </span>
      <RowTime>{row.time}</RowTime>
    </RowFrame>
  );
}

/** Stop for a running task, shown on hover, with a line under the row when it was refused. */
export function TaskStop(props: { task: BackgroundTask; tabbable?: boolean | undefined }) {
  const stop = useStopIntent();
  return (
    <>
      {stop.failed && (
        <span
          role="alert"
          data-tone="failed"
          className="order-last w-full px-2 pb-1 text-xs text-(--tone-text)"
        >
          {props.task.kind === "subagent"
            ? "Couldn't stop this agent. Try again."
            : "Couldn't stop this command. Try again."}
        </span>
      )}
      <button
        type="button"
        // In the tree, S reaches it; in a plain list it is its own Tab stop.
        tabIndex={props.tabbable ? undefined : -1}
        data-stop=""
        disabled={stop.busy}
        onKeyDown={backToRow}
        onClick={() => void stop.send({ type: "background_task.stop", taskId: props.task.id })}
        className="focus-ring mr-1.5 hidden shrink-0 rounded-sm px-1 text-xs text-muted-foreground group-focus-within/row:inline group-hover/row:inline hover:text-foreground pointer-coarse:inline"
      >
        {stop.busy ? "Stopping…" : "Stop"}
      </button>
    </>
  );
}

/** A background command still running, under the agent that started it, with Stop on hover. */
export function CommandLine(props: RowProps & { node: CommandForestNode; viewed: string }) {
  const row = useCommandRowFacts(props.node, props.viewed);
  return (
    <RowFrame
      {...props}
      rowKey={props.node.key}
      label={row.label}
      title={row.command}
      onOpen={row.open}
      actions={props.node.task.stoppable ? <TaskStop task={props.node.task} /> : undefined}
    >
      <span
        aria-hidden
        className="w-3.5 shrink-0 text-center font-mono text-xs text-subtle-foreground"
      >
        $
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.command}</span>
      <RowTime>{row.time}</RowTime>
    </RowFrame>
  );
}

/**
 * Finished siblings folded into one quiet line, "19 done", in the grey of a row's step. A click
 * (or →) opens them in place below it; the choice is kept with the tab's other folds.
 */
export function FinishedLine(props: RowProps & { rowKey: string; count: number }) {
  const words = `${props.count} done`;
  return (
    <RowFrame {...props} label={words}>
      <span aria-hidden className="w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-subtle-foreground">{words}</span>
    </RowFrame>
  );
}
