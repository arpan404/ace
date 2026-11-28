import { compactRefusal, contextCompacting, contextUsage, type ContextUsage } from "@ace/ui-core";
import { useAgent, useThread, useThreadMeta } from "@ace/client-react";
import { useThreadField } from "@ace/client-react/thread-field";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { ArrowsInSimpleIcon } from "@ace/icons";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { threadRootAgentId } from "@/lib/thread-fields.ts";
import { useCompactCommand } from "./compact-command.ts";

/*
 * How full the root agent's context is, and the provider's own compaction: "62% context" with a
 * compact icon in the strip above the composer. Shown whenever a sample is known (or while the
 * provider compacts), and nothing at all when it isn't: ace never guesses occupancy. The icon is
 * there only for a provider with native compaction, and while it can't take one it says why.
 */

export interface ContextControl {
  /** The root agent's occupancy, once a sample arrived. */
  usage: ContextUsage | undefined;
  /** The provider is compacting right now: the row says so, and the button waits. */
  compacting: boolean;
  /** The thread's provider can compact its own context. */
  supported: boolean;
  /** Why the button can't be used now, or undefined when it can. */
  reason: string | undefined;
  /** The button is on its way or the provider is compacting. */
  pending: boolean;
  /** There is a readout to show (or work to report): the strip's context row is present. */
  present: boolean;
  run(): void;
}

const readContext = (reader: ThreadReader) => reader.context;

export function useContextControl(threadId: string): ContextControl {
  const thread = useThreadMeta(threadId);
  const rootId = useThreadField(threadId, threadRootAgentId) ?? "";
  const keys = useMemo<readonly ThreadKey[]>(() => ["thread", `context:${rootId}`], [rootId]);
  const meter = useThread(threadId, keys, readContext);
  const agent = useAgent(threadId, rootId);
  const compact = useCompactCommand(threadId);
  const [sending, setSending] = useState(false);
  const usage = contextUsage(meter);
  const compacting = contextCompacting(agent?.status);
  const supported = thread?.capabilities?.compaction === true;
  const pending = sending || compacting;
  const reason = compactRefusal(agent?.status);
  const run = useCallback(() => {
    setSending(true);
    void compact().finally(() => setSending(false));
  }, [compact]);
  return {
    usage,
    compacting,
    supported,
    reason: pending ? "Compacting now" : reason,
    pending,
    present: usage !== undefined || compacting,
    run,
  };
}

/** The strip's own row when it has nothing else to say: the readout and its compact icon. */
export function ContextStrip(props: { view: ContextControl; indicators: ReactNode }) {
  const { view } = props;
  return (
    <div
      role="status"
      aria-label={view.compacting ? "Compacting context" : view.usage?.long}
      className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs"
    >
      <span className="min-w-0 flex-1 truncate">
        <ContextWords view={view} />
      </span>
      {props.indicators}
      {view.supported && <CompactButton view={view} />}
    </div>
  );
}

/**
 * The readout beside whatever else the strip shows, so the card never loses it, followed by its
 * compact icon. Absent while nothing is known.
 */
export function ContextTrailing(props: { view: ContextControl }) {
  const { view } = props;
  if (!view.present) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      <ContextWords view={view} />
      {view.supported && <CompactButton view={view} />}
    </span>
  );
}

function ContextWords(props: { view: ContextControl }) {
  const { view } = props;
  if (view.compacting)
    return (
      <>
        <Spinner />
        <span className="text-foreground"> Compacting context…</span>
      </>
    );
  if (!view.usage) return null;
  const percent = view.usage.percent !== undefined;
  return (
    <span title={view.usage.long}>
      <span className="text-foreground tabular-nums">{view.usage.short}</span>
      {percent && <span className="text-muted-foreground"> context</span>}
    </span>
  );
}

function CompactButton(props: { view: ContextControl }) {
  const { view } = props;
  return (
    <IconButton
      icon={ArrowsInSimpleIcon}
      label="Compact context"
      size="sm"
      disabled={view.pending || view.reason !== undefined}
      reason={view.reason}
      aria-busy={view.pending}
      onClick={view.run}
    />
  );
}
