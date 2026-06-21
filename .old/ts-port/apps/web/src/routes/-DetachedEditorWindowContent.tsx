import { ThreadId } from "@ace/contracts";
import { useEffect, useRef } from "react";

import {
  resolveEditorInstanceStateScopeId,
  resolveEditorWindowStateInstanceId,
  useEditorStateStore,
} from "../editorStateStore";
import { useServerAvailableEditors, useServerKeybindings } from "../rpc/serverState";
import { useStore } from "../store";
import { toastManager } from "../components/ui/toast";
import { DetachedEditorWindowBody } from "./-DetachedEditorWindowBody";
import { DetachedThreadSnapshotBootstrap } from "./-DetachedThreadSnapshotBootstrap";

export function DetachedEditorWindowContent(props: {
  threadId: string | null;
  connectionUrl: string | null;
  editorStateInstanceId: string | null;
  placement: string | null;
  workspaceMode: string | null;
}) {
  const threadId = props.threadId ? ThreadId.makeUnsafe(props.threadId) : null;
  const thread = useStore((store) =>
    threadId
      ? (store.threadsById?.[threadId] ??
        store.threads.find((candidate) => candidate.id === threadId) ??
        null)
      : null,
  );
  const project = useStore((store) =>
    thread ? (store.projects.find((candidate) => candidate.id === thread.projectId) ?? null) : null,
  );
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const clearEditorThreadState = useEditorStateStore((state) => state.clearThreadState);
  const returningToMainWindowRef = useRef(false);
  const fallbackEditorStateInstanceId = `detached-${resolveEditorWindowStateInstanceId()}`;
  const inputEditorStateInstanceId =
    typeof props.editorStateInstanceId === "string"
      ? props.editorStateInstanceId.trim() || undefined
      : undefined;
  const editorStateInstanceId = inputEditorStateInstanceId ?? fallbackEditorStateInstanceId;
  const editorStateScopeId =
    threadId && thread && project
      ? resolveEditorInstanceStateScopeId({
          gitCwd: thread.worktreePath ?? project.cwd,
          instanceId: editorStateInstanceId,
          threadId,
        })
      : null;
  const moveEditorBackToAce = async () => {
    const returnDetachedWindow = window.desktopBridge?.returnDetachedWindow;
    if (!returnDetachedWindow || !props.threadId) {
      return;
    }
    const placement =
      props.placement === "bottom" || props.placement === "right" || props.placement === "workspace"
        ? props.placement
        : undefined;
    const workspaceMode =
      props.workspaceMode === "editor" || props.workspaceMode === "split"
        ? props.workspaceMode
        : undefined;
    const returned = await returnDetachedWindow({
      kind: "editor",
      threadId: props.threadId,
      ...(props.connectionUrl ? { connectionUrl: props.connectionUrl } : {}),
      ...(editorStateInstanceId ? { editorStateInstanceId } : {}),
      ...(placement ? { placement } : {}),
      ...(workspaceMode ? { workspaceMode } : {}),
    });
    if (returned) {
      returningToMainWindowRef.current = true;
      window.close();
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not move editor back",
      description: "The desktop app did not restore the editor panel.",
    });
  };

  useEffect(() => {
    if (!editorStateScopeId) {
      return;
    }
    const clearDetachedEditorState = () => {
      if (returningToMainWindowRef.current) {
        return;
      }
      clearEditorThreadState(editorStateScopeId);
    };
    window.addEventListener("pagehide", clearDetachedEditorState);
    window.addEventListener("beforeunload", clearDetachedEditorState);
    return () => {
      window.removeEventListener("pagehide", clearDetachedEditorState);
      window.removeEventListener("beforeunload", clearDetachedEditorState);
    };
  }, [clearEditorThreadState, editorStateScopeId]);

  return (
    <>
      <DetachedThreadSnapshotBootstrap
        connectionUrl={props.connectionUrl}
        threadId={props.threadId}
      />
      <DetachedEditorWindowBody
        availableEditors={availableEditors}
        connectionUrl={props.connectionUrl}
        editorStateInstanceId={editorStateInstanceId}
        keybindings={keybindings}
        moveEditorBackToAce={moveEditorBackToAce}
        project={project}
        thread={thread}
        threadId={threadId}
      />
    </>
  );
}
