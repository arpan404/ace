import { useThreadError, useThreadMeta } from "@ace/client-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { AgentPanel } from "@/features/agents/agent-panel.tsx";
import { ChangesPanel } from "@/features/review/changes-panel.tsx";
import { PreviewPanel } from "@/features/preview/preview-panel.tsx";
import { Screen } from "@/features/shell/screen.tsx";
import { LogsPanel, TerminalPanel } from "@/features/terminal/terminal-panel.tsx";
import { ThreadComposer } from "./composer/thread-composer.tsx";
import { GitButton, OpenButton, RunButton } from "./header/header-actions.tsx";
import { RenameDialog, ThreadMenuItems } from "./header/thread-menu.tsx";
import { useThreadSources, type ThreadRef } from "./sources/index.ts";
import { Transcript } from "./transcript/transcript.tsx";

/**
 * A thread: the transcript and composer in the main column, Run · Open · Commit in the header,
 * Changes · Preview · Agents on the right and Terminal · Logs below.
 */
export function ThreadView(props: { threadId: string }) {
  const meta = useThreadMeta(props.threadId);
  const error = useThreadError(props.threadId);
  const sources = useThreadSources();
  const renamed = useSyncExternalStore(sources.actions.subscribe, () =>
    sources.actions.title(props.threadId),
  );
  const [renaming, setRenaming] = useState(false);
  const id = props.threadId;
  const title = renamed ?? meta?.title;
  const thread = useMemo<ThreadRef | undefined>(
    () => (meta && title !== undefined ? { id, workspaceId: meta.workspaceId, title } : undefined),
    [id, meta, title],
  );
  return (
    <Screen
      title={title ?? "Loading thread…"}
      subtitle={meta?.workspaceId}
      menu={thread && <ThreadMenuItems thread={thread} onRename={() => setRenaming(true)} />}
      actions={
        thread && (
          <>
            <RunButton thread={thread} />
            <OpenButton thread={thread} />
            <GitButton thread={thread} />
          </>
        )
      }
      right={{
        label: "Thread panel",
        tabs: [
          {
            id: "changes",
            label: "Changes",
            shortcut: "changes",
            content: <ChangesPanel threadId={id} />,
          },
          { id: "preview", label: "Preview", content: <PreviewPanel threadId={id} /> },
          {
            id: "agents",
            label: "Agents",
            shortcut: "agents",
            content: <AgentPanel threadId={id} />,
          },
        ],
      }}
      bottom={{
        label: "Bottom panel",
        tabs: [
          { id: "terminal", label: "Terminal", content: <TerminalPanel threadId={id} /> },
          { id: "logs", label: "Logs", content: <LogsPanel threadId={id} /> },
        ],
      }}
    >
      {error ? (
        <p role="alert" className="p-4 text-ui text-status-failed">
          This thread could not be loaded ({error.message}).
        </p>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            <Transcript threadId={id} />
          </div>
          {thread && (
            <ThreadComposer thread={thread} status={meta?.status} provider={meta?.provider} />
          )}
        </div>
      )}
      {renaming && thread && <RenameDialog thread={thread} onClose={() => setRenaming(false)} />}
    </Screen>
  );
}
