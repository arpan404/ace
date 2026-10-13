import type { ThreadReader } from "@ace/client";
import {
  arrayEqual,
  useAgent,
  useAgentTree,
  useInteractions,
  useThread,
  useThreadError,
  useThreadMeta,
} from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { agentName, modelLabel, providerNames, subagentEnded, subagentPhase } from "@ace/ui-core";
import { RobotIcon } from "@phosphor-icons/react";
import { Suspense, useCallback, useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import {
  countSubagents,
  findAgentNode,
  StopAgent,
  threadWorkspace,
  useTreeWork,
} from "@/features/panels/index.ts";
import { Screen } from "@/features/shell/index.ts";
import type { AgentFacts } from "@/lib/agent-facts.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { ComposerDock } from "../composer/composer-dock.tsx";
import { readingColumn } from "../lib/column.ts";
import { branchEqual, readSubagentBranch } from "../lib/subagent-group.ts";
import { ThreadLoadError } from "../thread-load-error.tsx";
import { AgentTranscript } from "../transcript/agent-transcript.tsx";
import { SubagentCrumb } from "../header/thread-crumb.tsx";
import { WorkButton } from "../header/work-button.tsx";
import { createWorkCardStore, WorkCardContext } from "../header/work-card-store.ts";
import { WorkSide } from "../header/work-side.tsx";
import { SubagentFocusProvider } from "./focus.ts";
import { SubagentLiveLine } from "./subagent-live-line.tsx";
import { SubagentStatusBar } from "./subagent-status-bar.tsx";
import { SubagentPrompt } from "./subagent-prompt.tsx";

/**
 * A provider's own subagent as the whole chat: its transcript in the reading column, `parent /
 * name` in the header with the thread's details icon and card (where Lineage places it), and the
 * thread's panel beside it. Nobody can message a provider's subagent (only the agent that
 * started it can), so a status bar stands where the composer would.
 */
export function SubagentView(props: { threadId: string; agentId: string }) {
  const { threadId, agentId } = props;
  const meta = useThreadMeta(threadId);
  const error = useThreadError(threadId);
  const agent = useAgent(threadId, agentId);
  const parent = useAgent(threadId, agent?.parentId ?? "");
  const root = !parent || parent.origin === "root";
  const [details] = useState(createWorkCardStore);
  useHotkey(keymap.workCard.keys, details.toggle, { id: "workCard" });
  return (
    <SubagentFocusProvider value={agentId}>
      <WorkCardContext value={details}>
        <Screen
          crumb={
            agent?.parentId && <SubagentCrumb threadId={threadId} parentAgentId={agent.parentId} />
          }
          title={
            agent
              ? agentName(agent)
              : error
                ? "Subagent unavailable"
                : meta
                  ? "Subagent"
                  : "Loading…"
          }
          tools={meta && !error && <WorkButton threadId={threadId} />}
          workspace={{ scope: threadId, definition: threadWorkspace }}
        >
          {error ? (
            <ThreadLoadError error={error} />
          ) : !meta ? (
            <SkeletonText lines={4} className={`${readingColumn} pt-16`} />
          ) : !agent ? (
            <EmptyState
              icon={RobotIcon}
              title="This subagent isn't in the loaded thread"
              description="It may belong to older history that hasn't loaded yet."
            />
          ) : (
            <div
              data-thread-column
              className="relative grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
            >
              <WorkSide threadId={threadId} />
              <div className="col-start-1 row-start-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain">
                <div
                  className={`${readingColumn} pt-6 pb-[calc(var(--composer-clearance,0px)+2rem)]`}
                >
                  {agent.spawnedBy && (
                    <SubagentPrompt threadId={threadId} spawnedBy={agent.spawnedBy} />
                  )}
                  {/* As in a thread, the live line heads the work in progress. */}
                  <SubagentLive threadId={threadId} agent={agent} />
                  <AgentTranscript threadId={threadId} agentId={agentId} />
                </div>
              </div>
              <SubagentBottom threadId={threadId} agent={agent} root={root} />
            </div>
          )}
        </Screen>
      </WorkCardContext>
    </SubagentFocusProvider>
  );
}

/** One subagent's whole branch, read with the rule its card in the parent uses. */
function useBranch(threadId: string, agentId: string) {
  const read = useCallback(
    (facts: AgentFacts) => readSubagentBranch(facts.reader, agentId, facts),
    [agentId],
  );
  const branch = useAgentFacts(threadId, read, branchEqual);
  return { branch, phase: subagentPhase(branch?.state ?? "working") };
}

function SubagentLive(props: { threadId: string; agent: Agent }) {
  const { phase } = useBranch(props.threadId, props.agent.id);
  const { work } = useTreeWork(props.threadId);
  const tree = useAgentTree(props.threadId);
  const node = tree && findAgentNode(tree, props.agent.id);
  const running = node ? node.children.filter((child) => work.running.has(child.id)).length : 0;
  return (
    <SubagentLiveLine
      threadId={props.threadId}
      agent={props.agent}
      phase={phase}
      subagents={running}
    />
  );
}

/**
 * Its open requests in the composer's one strip, then the bar: model and effort, how it ended
 * or how long it has worked (its whole branch: never "Completed" while anything under it
 * runs or waits on the person), Stop while it runs and Open parent.
 */
function SubagentBottom(props: { threadId: string; agent: Agent; root: boolean }) {
  const { threadId, agent } = props;
  const meta = useThreadMeta(threadId);
  const { branch, phase } = useBranch(threadId, agent.id);
  const requests = useBranchRequests(threadId, agent.id);
  const tree = useAgentTree(threadId);
  const node = tree && findAgentNode(tree, agent.id);
  // A provider whose subagents are read-only refuses a Stop aimed at one of them.
  const stoppable = meta?.capabilities?.childControls !== "read-only";
  return (
    <ComposerDock>
      {requests.length > 0 && (
        <Suspense fallback={null}>
          <DeferredRequests.Component threadId={threadId} ids={requests} />
        </Suspense>
      )}
      <SubagentStatusBar
        provider={agent.native.provider}
        acpAgentId={agent.native.acpAgentId}
        model={agent.model ? modelLabel(agent.model) : providerNames[agent.native.provider]}
        phase={phase}
        startedAt={agent.createdAt}
        endedAt={subagentEnded(phase) ? branch?.end : undefined}
        runs={agent.background ? "Runs in the background" : "Runs on its own"}
        parent={
          agent.parentId
            ? props.root
              ? { threadId }
              : { threadId, agentId: agent.parentId }
            : undefined
        }
        actions={
          stoppable &&
          !subagentEnded(phase) && (
            <StopAgent
              threadId={threadId}
              agent={agent}
              pending
              subagents={node ? countSubagents(node) : 0}
            />
          )
        }
      />
    </ComposerDock>
  );
}

// Its code loads only for a subagent that asks the person something.
const DeferredRequests = deferredComponent(() =>
  import("./subagent-requests.tsx").then((module) => module.SubagentRequests),
);

/** Requests waiting on the person from this subagent or anything under it. */
function useBranchRequests(threadId: string, agentId: string): readonly string[] {
  const pending = useInteractions(threadId);
  const read = useCallback(
    (reader: ThreadReader) =>
      (pending ?? []).filter((id) => {
        let owner = reader.interaction(id)?.agentId ?? null;
        const seen = new Set<string>();
        while (owner && !seen.has(owner)) {
          if (owner === agentId) return true;
          seen.add(owner);
          owner = reader.agent(owner)?.parentId ?? null;
        }
        return false;
      }),
    [pending, agentId],
  );
  return useThread(threadId, ["agents", "interactions"], read, arrayEqual) ?? none;
}
const none: readonly string[] = [];
