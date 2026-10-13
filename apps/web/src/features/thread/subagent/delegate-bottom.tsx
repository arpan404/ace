import { useAgent } from "@ace/client-react";
import type { Thread } from "@ace/protocol";
import {
  delegatedState,
  effortLabel,
  modelLabel,
  optionEffort,
  providerNames,
  rollupSubagent,
  subagentEnded,
  subagentPhase,
} from "@ace/ui-core";
import { ArrowBendDownRightIcon } from "@phosphor-icons/react";
import { useCallback, useState, type ReactNode } from "react";
import type { AgentFacts } from "@/lib/agent-facts.ts";
import { cn } from "@/lib/cn.ts";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { ComposerDock } from "../composer/composer-dock.tsx";
import { stripControl } from "../composer/composer-styles.ts";
import { runsNow } from "../composer/execution.ts";
import { branchEqual, readSubagentBranch } from "../lib/subagent-group.ts";
import { SubagentStatusBar } from "./subagent-status-bar.tsx";

/**
 * The bottom of a thread: its composer (`children`), unless ace delegated it and its whole tree
 * has ended. Then a status bar says how it went and leads back to the thread that delegated
 * it; ace still delivers a follow-up to it, so Continue brings the composer back.
 */
export function DelegateBottom(props: { thread: Thread; children: ReactNode }) {
  const parentThreadId = props.thread.delegatedBy;
  return parentThreadId ? (
    <Delegated thread={props.thread} parentThreadId={parentThreadId}>
      {props.children}
    </Delegated>
  ) : (
    props.children
  );
}

function Delegated(props: { thread: Thread; parentThreadId: string; children: ReactNode }) {
  const { thread } = props;
  const rootId = thread.rootAgentId ?? "";
  const root = useAgent(thread.id, rootId);
  const read = useCallback(
    (facts: AgentFacts) => readSubagentBranch(facts.reader, rootId, facts),
    [rootId],
  );
  const branch = useAgentFacts(thread.id, read, branchEqual);
  // Continue holds for the ended stretch it was pressed in; a later end shows the bar again.
  const [continued, setContinued] = useState<number>();
  // The daemon's status covers the whole tree and queued input; the branch adds how it ended.
  const listed = delegatedState(thread.status);
  const phase = subagentPhase(branch ? rollupSubagent(listed, branch.state) : listed);
  const end = branch?.end;
  if (!subagentEnded(phase) || (continued !== undefined && continued === (end ?? 0)))
    return props.children;
  const selection = runsNow(thread);
  const effort = optionEffort(selection.options);
  return (
    <ComposerDock>
      <SubagentStatusBar
        provider={selection.provider}
        acpAgentId={thread.acpAgentId}
        model={selection.model ? modelLabel(selection.model) : providerNames[selection.provider]}
        effort={effort && effortLabel(effort)}
        phase={phase}
        startedAt={root?.createdAt ?? thread.createdAt}
        endedAt={end}
        runs="Delegated by ace"
        parent={{ threadId: props.parentThreadId }}
        actions={
          <button
            type="button"
            onClick={() => setContinued(end ?? 0)}
            className={cn(stripControl, "h-8 shrink-0 text-ui text-foreground")}
          >
            <ArrowBendDownRightIcon aria-hidden size={15} className="shrink-0" />
            Continue
          </button>
        }
      />
    </ComposerDock>
  );
}
