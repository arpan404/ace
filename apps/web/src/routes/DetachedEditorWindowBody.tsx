import type { ThreadId } from "@ace/contracts";
import { lazy, Suspense } from "react";

import type { useServerAvailableEditors, useServerKeybindings } from "../rpc/serverState";
import type { useStore } from "../store";
import { DetachedWindowMessage } from "./DetachedWindowMessage";

const DetachedThreadWorkspaceEditor = lazy(
  () => import("../components/editor/ThreadWorkspaceEditor"),
);

export function DetachedEditorWindowBody(props: {
  availableEditors: ReturnType<typeof useServerAvailableEditors>;
  connectionUrl: string | null;
  editorStateInstanceId: string;
  keybindings: ReturnType<typeof useServerKeybindings>;
  moveEditorBackToAce: () => Promise<void>;
  project: ReturnType<typeof useStore.getState>["projects"][number] | null;
  thread: ReturnType<typeof useStore.getState>["threads"][number] | null;
  threadId: ThreadId | null;
}) {
  if (!props.threadId) {
    return <DetachedWindowMessage title="Editor unavailable" description="Missing thread id." />;
  }
  if (!props.thread || !props.project) {
    return (
      <DetachedWindowMessage title="Loading editor" description="Preparing workspace state..." />
    );
  }

  const gitCwd = props.thread.worktreePath ?? props.project.cwd;
  return (
    <div className="relative h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <Suspense
        fallback={<DetachedWindowMessage title="Loading editor" description="Starting editor..." />}
      >
        <DetachedThreadWorkspaceEditor
          availableEditors={props.availableEditors}
          branch={props.thread.branch}
          browserOpen={false}
          connectionUrl={props.connectionUrl}
          gitCwd={gitCwd}
          keybindings={props.keybindings}
          lspCwd={props.project.cwd}
          terminalOpen={false}
          threadId={props.threadId}
          worktreePath={props.thread.worktreePath}
          editorStateInstanceId={props.editorStateInstanceId}
          workspaceMode="editor"
          detachEnabled={false}
          onReturnToMainWindow={() => {
            void props.moveEditorBackToAce();
          }}
        />
      </Suspense>
    </div>
  );
}
