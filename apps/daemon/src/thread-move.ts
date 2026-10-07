import { realpath } from "node:fs/promises";
import { ProjectStorage } from "./project-storage.ts";
import { ProjectError } from "./project-policy.ts";
import { threadHasPendingWork } from "./thread-organization.ts";
import { threadMoveError, movedThreadDetails, threadMoveEvents } from "@ace/projection";
import type { Command, CommandResult, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";
import type { WorkspaceRuntimeOptions } from "./workspace-runtime.ts";

/** The existing workspace fence owns session shutdown and atomic rebinding. No Git writes. */
export async function moveThread(
  store: Store,
  command: Command,
  now: () => number,
  ownsWork: (id: ThreadId) => boolean,
  changeWorkspace: WorkspaceRuntimeOptions["changeWorkspace"],
  allowed: () => boolean,
): Promise<Omit<CommandResult, "commandId">> {
  const p = command.payload;
  if (p.type !== "thread.move") return { ok: false, error: "invalid_command" };
  const projects = new ProjectStorage(store, now);
  try {
    const thread = store.getThread(p.threadId);
    if (!thread) return { ok: false, error: "thread_not_found" };
    const error = threadMoveError(thread);
    if (error) return { ok: false, error };
    if (threadHasPendingWork(store, thread.id, ownsWork))
      return { ok: false, error: "thread_busy" };
    const project = projects.get(p.workspaceId);
    if (thread.workspaceId === project.id) return { ok: true, threadId: thread.id };
    const source = store.executionWorkspace(thread.id);
    if (!source.ready) return { ok: false, error: "workspace_preparing" };
    const oldProject = store.getWorkspacePath(thread.workspaceId);
    if (!oldProject || source.path !== (await realpath(oldProject)))
      return { ok: false, error: "thread_move_requires_local_workspace" };
    const destination = await realpath(project.path);
    const target = { ...project, path: destination };
    store.workspaceReservations.assertAvailable(destination);
    const result = { commandId: command.id, ok: true, threadId: thread.id };
    const commit = () => {
      if (!allowed()) throw new ProjectError("forbidden");
      const current = projects.get(project.id);
      if (current.path !== project.path || current.name !== project.name)
        throw new ProjectError("workspace_changed");
      if (ownsWork(thread.id)) throw new ProjectError("thread_busy");
      store.appendEvents(thread.id, threadMoveEvents(thread, target), now());
      store.completeAsyncCommand(command.id, result);
    };
    const hasSession = store.atomic((db) =>
      Boolean(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'")
          .get() && db.prepare("SELECT 1 FROM engine_sessions WHERE thread_id=?").get(thread.id),
      ),
    );
    if (hasSession) {
      if (!changeWorkspace) return { ok: false, error: "engine_unavailable" };
      await changeWorkspace(
        thread.id,
        command.id,
        async () => movedThreadDetails(thread, target),
        { roots: [source.path, destination], hasOwnedWork: ownsWork, threads: [thread.id] },
        commit,
      );
    } else {
      store.atomic(() => {
        const current = store.getThread(thread.id);
        if (!current || current.workspaceId !== thread.workspaceId)
          throw new ProjectError("workspace_changed");
        const changed = threadMoveError(current);
        if (changed || threadHasPendingWork(store, thread.id, ownsWork))
          throw new ProjectError(changed ?? "thread_busy");
        store.workspaceReservations.assertAvailable(source.path);
        store.workspaceReservations.assertAvailable(destination);
        commit();
      });
    }
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof ProjectError ? error.code : "thread_move_failed" };
  }
}
