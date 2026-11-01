import {
  agentOutcome,
  agentStep,
  askWords,
  backgroundCommand,
  foldWords,
  formatSpan,
  isRunning,
  pluralCount,
  type AgentForestNode,
  type CommandForestNode,
} from "@ace/ui-core";
import { useItem, useThreadMeta } from "@ace/client-react";
import type { Interaction, ProviderKind } from "@ace/protocol";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { KeyboardEvent, ReactNode } from "react";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { cn } from "@/lib/cn.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useReducedMotion } from "@/lib/motion.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { useNow } from "@/lib/time.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useAgentDetails } from "../agents/agent-details.ts";
import { useAgentIdentity } from "../agents/agent-identity.ts";
import { StopAgent } from "../agents/stop-agent.tsx";
import { useStopIntent } from "../agents/use-stop-intent.ts";

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
function backToRow(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
  const row = event.currentTarget
    .closest("[data-row-frame]")
    ?.querySelector<HTMLElement>('[role="treeitem"]');
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
  const thread = useThreadMeta(node.threadId);
  const identity = useAgentIdentity(node.threadId, agent);
  const details = useAgentDetails(thread, agent);
  // A delegate's own work is its thread's main agent's: its step reads from there once loaded.
  const doer = node.childRoot ?? agent;
  const status = doer.status;
  const tool = useItem(
    node.childRoot ? node.childThread : node.threadId,
    status.state === "working" && status.itemId ? status.itemId : "",
  );
  const openSubagent = useOpenSubagent();
  const now = useNow();
  const root = agent.origin === "root" && node.threadId === props.viewed;
  const asks = props.request ? askWords(props.request.request) : undefined;
  const own = isRunning(doer);
  const below = node.tally;
  const asking =
    props.request !== undefined || (status.state === "blocked" && status.on === "human");
  const tone = asking ? "needs-you" : status.state === "failed" ? "failed" : undefined;
  const current = props.request
    ? asks
      ? `asks: ${asks}`
      : agentStep({ status, interaction: props.request })
    : status.state === "failed"
      ? // Its own words are in its view; a raw provider error doesn't belong in the tree.
        "couldn't finish"
      : own && node.live
        ? agentStep({ status, item: tool })
        : node.live
          ? below.working || below.commands
            ? `waiting on ${pluralCount(below.working + below.commands, below.working ? "agent" : "command")}`
            : agentStep({ status, item: tool })
          : (agentOutcome(identity.spawn) ?? "finished");
  const fresh = useLiveConnection().fresh;
  // Facts not confirmed since the connection dropped or the Summary opened: what it was doing
  // when last seen, and never "finished" for a branch that may be working again.
  const stale = !fresh || node.stale;
  // Settled-looking while something under it isn't confirmed or couldn't load: it may still be
  // working, so it reads neither finished nor done. A failure or a request is known for sure.
  const uncertain =
    !node.live && node.unconfirmed && !stale && status.state !== "failed" && !props.request;
  const unsure = node.live ? `last seen ${current}` : "syncing";
  // An unloaded delegate says only "not loaded": that is why it isn't sure.
  const seen = stale ? unsure : !uncertain ? current : node.notLoaded ? "" : "syncing";
  const step = node.notLoaded ? (seen ? `${seen} · not loaded` : "not loaded") : seen;
  // A settled-looking row that isn't sure already says so; its fold adds nothing to that.
  const settledLook = !node.live && (stale || uncertain);
  const folded = props.expanded === false && !settledLook ? foldWords(below) : "";
  const end = agent.endedAt ?? (node.live ? Math.max(now, agent.createdAt) : undefined);
  const time =
    end !== undefined && end - agent.createdAt >= 1000 ? formatSpan(agent.createdAt, end) : "";
  const open = root
    ? undefined
    : () =>
        openSubagent({
          threadId: node.threadId,
          agentId: agent.id,
          childThreadId: agent.childThreadId,
        });
  const name = identity.name;
  const done = !node.live && !stale && !uncertain;
  return (
    <RowFrame
      {...props}
      rowKey={node.key}
      label={`${name}: ${step}${folded ? ` · ${folded}` : ""}`}
      title={[name, ...details.lines].filter(Boolean).join("\n")}
      onOpen={open}
      actions={
        own && !root ? (
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
        instance={details.instance}
        live={node.live}
        done={done}
        stale={stale || uncertain}
      />
      <span
        className={cn(
          "max-w-[55%] min-w-0 shrink truncate font-medium",
          (done || settledLook) && "text-muted-foreground",
        )}
      >
        {name}
      </span>
      <span
        data-tone={tone}
        className={cn(
          "min-w-0 flex-1 truncate",
          tone ? "text-(--tone-text)" : "text-subtle-foreground",
        )}
      >
        {step}
        {folded && <span className="text-subtle-foreground"> · {folded}</span>}
      </span>
      <RowTime>{time}</RowTime>
    </RowFrame>
  );
}

/** A background command still running, under the agent that started it, with Stop on hover. */
export function CommandLine(props: RowProps & { node: CommandForestNode; viewed: string }) {
  const { task } = props.node;
  const item = useItem(props.node.threadId, task.toolCallId ?? "");
  const workspace = useWorkspaceActions(props.viewed);
  const stop = useStopIntent();
  const now = useNow();
  const command = backgroundCommand(task, item);
  const fresh = useLiveConnection().fresh && !props.node.unconfirmed;
  const end = Math.max(now, task.startedAt);
  // Its output opens in this thread's terminal; a delegated thread's opens there.
  const show =
    props.node.threadId === props.viewed
      ? () => workspace.open({ kind: "shell", id: task.id })
      : undefined;
  return (
    <RowFrame
      {...props}
      rowKey={props.node.key}
      label={`$ ${command}: ${fresh ? "running" : "last seen running"}`}
      title={command}
      onOpen={show}
      actions={
        task.stoppable ? (
          <>
            {stop.failed && (
              <span
                role="alert"
                data-tone="failed"
                className="order-last w-full px-2 pb-1 text-xs text-(--tone-text)"
              >
                Couldn't stop this command. Try again.
              </span>
            )}
            <button
              type="button"
              tabIndex={-1}
              data-stop=""
              disabled={stop.busy}
              onKeyDown={backToRow}
              onClick={() => void stop.send({ type: "background_task.stop", taskId: task.id })}
              className="focus-ring mr-1.5 hidden shrink-0 rounded-sm px-1 text-xs text-muted-foreground group-focus-within/row:inline group-hover/row:inline hover:text-foreground pointer-coarse:inline"
            >
              {stop.busy ? "Stopping…" : "Stop"}
            </button>
          </>
        ) : undefined
      }
    >
      <span
        aria-hidden
        className="w-3.5 shrink-0 text-center font-mono text-xs text-subtle-foreground"
      >
        $
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{command}</span>

      <RowTime>{end - task.startedAt >= 1000 ? formatSpan(task.startedAt, end) : ""}</RowTime>
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
