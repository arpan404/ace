import {
  ExecutionOptions,
  type AccessMode,
  type AgentId,
  type ProviderKind,
  type ThreadId,
  type WorkspaceId,
} from "@ace/protocol";
import { createEngineThread } from "./create-thread.ts";
import type { EngineRepository } from "./repository.ts";

export interface HostThreadInput {
  id: ThreadId;
  workspaceId: WorkspaceId;
  title: string;
  /** Recorded only: a delegation that names no provider takes it, as from any parent. */
  provider: ProviderKind;
  /** The ceiling the thread's children are contained by. */
  access: AccessMode;
  cwd: string;
  host: "spade";
}

/**
 * Threads the daemon holds for its own processes (ADR 0117): Spade's MCP calls act as the thread's
 * root agent, so what Spade delegates becomes its children. No session is ever made for it, and
 * the engine refuses every command that would run an agent in it (`hostRefusal`).
 */
export class HostThreads {
  private repo: EngineRepository;
  private now: () => number;
  constructor(repo: EngineRepository, now: () => number) {
    this.repo = repo;
    this.now = now;
  }
  /** Makes the thread unless it exists; returns its root agent, which MCP leases name. */
  create(input: HostThreadInput): AgentId | undefined {
    const { repo } = this;
    if (!repo.store.getThread(input.id)) {
      const workspace = repo.store.getWorkspace(input.workspaceId);
      repo.store.atomic(() =>
        createEngineThread(repo, {
          id: input.id,
          access: input.access,
          workspaceId: input.workspaceId,
          title: input.title,
          titleSource: "agent",
          selection: { provider: input.provider, options: ExecutionOptions.parse({}) },
          cwd: input.cwd,
          at: this.now(),
          silenceMs: 60_000,
          client: {
            host: input.host,
            details: {
              workspace: {
                id: input.workspaceId,
                name: workspace?.name ?? input.workspaceId,
                path: input.cwd,
              },
              mode: "local",
              worktree: input.cwd,
            },
          },
        }),
      );
      // Announces the root agent, which MCP leases name, and leaves it idle: one empty turn
      // that ended, so the root never reads as starting or, after the silence bound, as stuck.
      repo.apply(
        input.id,
        [
          { type: "turn.started", agent: "root", trigger: "restart" },
          { type: "turn.ended", agent: "root", outcome: "completed" },
        ],
        this.now(),
      );
    }
    return repo.store.getThread(input.id)?.rootAgentId;
  }
  /** Brings a host thread's access, the ceiling of everything it delegates, up to date. */
  setAccess(id: ThreadId, access: AccessMode): void {
    this.repo.permissions.hold(id, access, this.now());
  }
}
