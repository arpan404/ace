import { useItem, useSidebarThread } from "@ace/client-react";
import { delegatedState, startedThreadOf, subagentTerminal } from "@ace/ui-core";
import { GitForkIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useProjectName } from "@/lib/projects.ts";
import { useThreadLiveState } from "../lib/live-state.ts";
import { AgentRowContents, agentRowStyles } from "./agent-row.tsx";
import { SubagentElapsed } from "./subagent-row.tsx";
import { StaticRow } from "./transcript-row.tsx";
import { ThreadLink } from "../transitions/thread-link.tsx";

/**
 * The conversation an agent started with `thread_start`, as an agent row where it was started:
 * its provider's mark, its title, "New thread · project", its status and how long it has run,
 * updated in place as it works and ends. The row opens it. The title and status follow the
 * thread once the sidebar knows it (a rename, a finish); before then, ace's answer names it.
 * Nothing shows until ace answers with the thread, and nothing for a call that failed: its step
 * says so. A fork (`thread_fork`) is a thread of its own, not this one's agent: one quiet line
 * links to it.
 */
export function StartedThreadCard(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  const started = useMemo(() => startedThreadOf(item), [item]);
  const thread = useSidebarThread(started?.threadId ?? "");
  const projectName = useProjectName();
  const live = useThreadLiveState(props.threadId);
  if (!started) return null;
  if (started.forked) return <ForkedToRow threadId={started.threadId} title={started.title} />;
  const label = "New thread";
  const title = thread?.title ?? started.title ?? label;
  const provider = thread?.execution?.provider ?? thread?.provider ?? started.provider;
  const model = thread?.execution?.model ?? started.model;
  const state = thread ? delegatedState(thread.status) : "working";
  const terminal = subagentTerminal(state);
  return (
    <section aria-label={`${label}: ${title}`}>
      <Link
        to="/t/$threadId"
        params={{ threadId: started.threadId }}
        aria-label={`Open ${title}`}
        className={agentRowStyles.box}
      >
        <AgentRowContents
          mark={{ provider, model }}
          name={title}
          meta={thread ? `${label} · ${projectName(thread.workspaceId)}` : label}
          state={state}
          stale={!live.fresh && !terminal}
          elapsed={
            thread && (
              <SubagentElapsed
                startedAt={thread.createdAt}
                endedAt={thread.updatedAt}
                running={!terminal}
                fresh={live.fresh}
              />
            )
          }
        />
      </Link>
    </section>
  );
}

/** "⑂ Forked to <title>": where an agent forked this thread, the fork under its current name. */
function ForkedToRow(props: { threadId: string; title: string | undefined }) {
  return (
    <div role="note">
      <StaticRow
        lead={<GitForkIcon aria-hidden size={14} />}
        title={
          <>
            Forked to <ThreadLink threadId={props.threadId} fallback={props.title ?? "a fork"} />
          </>
        }
      />
    </div>
  );
}
