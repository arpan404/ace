import { GitError, isMutationUnavailable, repositoryScope } from "@ace/git";
import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import { AsyncLocalStorage } from "node:async_hooks";

/** The existing workspace reservation owner fences all provider admission for one Git common
 * directory. Only bounded resident actors are inspected; no transcript history is scanned. */
export class RepositoryTransfers {
  private repo: EngineRepository;
  private actors: () => Iterable<ThreadId>;
  private active: (id: ThreadId) => Promise<boolean>;
  private wake: (id: ThreadId) => void;
  private scope = new AsyncLocalStorage<{ repository: string; token: string }>();
  constructor(
    repo: EngineRepository,
    actors: () => Iterable<ThreadId>,
    active: (id: ThreadId) => Promise<boolean>,
    wake: (id: ThreadId) => void,
  ) {
    this.repo = repo;
    this.actors = actors;
    this.active = active;
    this.wake = wake;
  }
  async assertAvailable(cwd: string): Promise<void> {
    const reservations = this.repo.store.workspaceReservations;
    reservations.assertAvailable(cwd);
    const repository = await repositoryScope(cwd);
    reservations.registerRepository(cwd, repository);
    reservations.assertAvailable(cwd);
  }
  async run<T>(repository: string, operation: () => Promise<T>): Promise<T> {
    // The public Git action fences preflight too. Its inner transport boundary reuses that
    // admission; an independent request has no inherited scope and must acquire its own.
    const reservations = this.repo.store.workspaceReservations;
    const inherited = this.scope.getStore();
    if (
      inherited?.repository === repository &&
      reservations.ownsRepositoryReservation(repository, inherited.token)
    )
      return operation();
    const token = this.repo.nextCommandId();
    // No await between admission and reservation. Newly accepted sends are denied again at
    // provider dispatch, including sends reusing an idle session in a newly linked worktree.
    this.repo.store.atomic(() => reservations.reserveRepository(repository, token));
    const peers = new Set<ThreadId>();
    let release = true;
    try {
      // Snapshot before awaits: a live Map iterator could keep absorbing newly created actors.
      const actors = [...this.actors()];
      for (const id of actors) {
        const session = this.repo.session(id);
        const thread = this.repo.store.getThread(id);
        const cwd = session.workspaceReady
          ? session.cwd
          : ((thread && this.repo.store.getWorkspacePath(thread.workspaceId)) ?? session.cwd);
        const admitted = reservations.repository(cwd);
        if (admitted === repository) {
          peers.add(id);
          await this.refuseActive(id);
        }
        const identity = await repositoryScope(cwd);
        // An active provider retains its admitted repository identity even if it rewrites
        // .git metadata. Also compare the current identity before admitting any transfer.
        if (identity !== repository && admitted !== repository) continue;
        peers.add(id);
        if (admitted !== repository) await this.refuseActive(id);
        reservations.registerRepository(cwd, identity);
      }
      return await this.scope.run({ repository, token }, operation);
    } catch (error) {
      if (isMutationUnavailable(error)) {
        // Unconfirmed process cleanup must not admit an agent that can rewrite shared config.
        // A restart retains this fence, just like an uncertain workspace mutation.
        release = false;
        if (error instanceof GitError && error.cleanup)
          void error.cleanup.settled
            .then((result) => {
              if (result.status !== "confirmed") return;
              reservations.releaseRepository(token);
              for (const id of peers) this.wake(id);
            })
            .catch(() => {});
      }
      throw error;
    } finally {
      if (release) reservations.releaseRepository(token);
      for (const id of peers) this.wake(id);
    }
  }
  private async refuseActive(id: ThreadId): Promise<void> {
    if (await this.active(id))
      throw new GitError(
        "repository_agent_running",
        "An agent is running in this repository; stop it or wait",
      );
  }
}
