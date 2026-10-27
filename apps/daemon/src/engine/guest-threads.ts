import {
  ExecutionOptions,
  type ProviderKind,
  type ThreadId,
  type WorkspaceId,
} from "@ace/protocol";
import { createEngineThread } from "./create-thread.ts";
import type { EngineRepository } from "./repository.ts";

export interface GuestThreadInput {
  id: ThreadId;
  workspaceId: WorkspaceId;
  title: string;
  /** Recorded only: a guest thread never launches its provider. */
  provider: ProviderKind;
  cwd: string;
  guest: { host: string; name: string };
}

/**
 * Threads that hold remote tool use from agents on other machines (ADR 0105). They are made
 * without a provider adapter, so a machine with no CLI installed can host them, and they show
 * work only through background rows that the host adds and ends.
 */
export class GuestThreads {
  private repo: EngineRepository;
  private now: () => number;
  private wake: (id: ThreadId) => void;
  constructor(repo: EngineRepository, now: () => number, wake: (id: ThreadId) => void) {
    this.repo = repo;
    this.now = now;
    this.wake = wake;
  }
  create(input: GuestThreadInput): void {
    const { repo } = this;
    if (repo.store.getThread(input.id)) return;
    const workspace = repo.store.getWorkspace(input.workspaceId);
    repo.store.atomic(() =>
      createEngineThread(repo, {
        id: input.id,
        workspaceId: input.workspaceId,
        title: input.title,
        titleSource: "agent",
        selection: { provider: input.provider, options: ExecutionOptions.parse({}) },
        cwd: input.cwd,
        at: this.now(),
        silenceMs: 60_000,
        client: {
          details: {
            workspace: {
              id: input.workspaceId,
              name: workspace?.name ?? input.workspaceId,
              path: input.cwd,
              ...(workspace?.kind ? { kind: workspace.kind } : {}),
            },
            mode: "local",
            worktree: input.cwd,
            guest: input.guest,
          },
        },
      }),
    );
  }
  /**
   * Adds or ends a stoppable background row on the thread's root agent. While one runs the
   * thread reads as waiting, never done; a stop is routed by `bindExternalTaskStop`.
   */
  hold(
    threadId: ThreadId,
    task: string,
    hold: { title: string } | { status: "completed" | "failed" | "stopped" },
  ): void {
    const state = this.repo.requireState(threadId);
    const agent = state.rootKey;
    if (agent === undefined) throw new Error("Guest thread has no root agent yet");
    this.repo.apply(
      threadId,
      [
        "title" in hold
          ? {
              type: "background.started",
              owner: "ace",
              agent,
              task,
              kind: "other",
              title: hold.title,
              stoppable: true,
            }
          : { type: "background.ended", task, status: hold.status },
      ],
      this.now(),
    );
    if (!("title" in hold)) this.wake(threadId);
  }
  /** Background rows still running whose key starts with `prefix`. */
  running(threadId: ThreadId, prefix: string): string[] {
    const tasks = this.repo.state(threadId)?.tasks ?? {};
    return Object.entries(tasks).flatMap(([key, task]) =>
      key.startsWith(prefix) && task.status === "running" ? [key] : [],
    );
  }
}
