import { GitError, repositoryScope } from "@ace/git";
import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import type { EngineClock } from "./actor.ts";
import { AsyncLocalStorage } from "node:async_hooks";

/** The existing workspace reservation owner fences all provider admission for one Git common
 * directory. Only bounded resident actors are inspected; no transcript history is scanned. */
export class RepositoryTransfers {
  private repo: EngineRepository;
  private actors: () => Iterable<ThreadId>;
  private active: (id: ThreadId) => boolean;
  private reconcile: (id: ThreadId) => Promise<void>;
  private clock: EngineClock;
  private wake: (id: ThreadId) => void;
  private scope = new AsyncLocalStorage<{ repository: string; token: string }>();
  constructor(
    repo: EngineRepository,
    actors: () => Iterable<ThreadId>,
    active: (id: ThreadId) => boolean,
    reconcile: (id: ThreadId) => Promise<void>,
    clock: EngineClock,
    wake: (id: ThreadId) => void,
  ) {
    this.repo = repo;
    this.actors = actors;
    this.active = active;
    this.reconcile = reconcile;
    this.clock = clock;
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
    let dispatched = false;
    const deadline = this.clock.now() + 1_000;
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
          this.assertIdle(id);
        }
        let identity: string;
        try {
          identity = await repositoryScope(cwd);
        } catch (error) {
          // A provider cannot erase its admitted ownership by corrupting .git. That same
          // retained identity establishes when a failed discovery is unrelated to our target.
          if (admitted !== undefined && admitted !== repository) continue;
          throw error;
        }
        // An active provider retains its admitted repository identity even if it rewrites
        // .git metadata. Also compare the current identity before admitting any transfer.
        if (identity !== repository && admitted !== repository) continue;
        peers.add(id);
        if (admitted !== repository) this.assertIdle(id);
        reservations.registerRepository(cwd, identity);
      }
      for (const id of peers) await this.refuseActive(id, deadline);
      dispatched = true;
      return await this.scope.run({ repository, token }, operation);
    } catch (error) {
      if (dispatched && error instanceof GitError && error.cleanup) {
        // Unconfirmed process cleanup must not admit an agent that can rewrite shared config.
        // A restart retains this fence, just like an uncertain workspace mutation.
        release = false;
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
  private async refuseActive(id: ThreadId, deadline: number): Promise<void> {
    // Never drain a mailbox to discover work that is already known to be running.
    this.assertIdle(id);
    const remaining = deadline - this.clock.now();
    if (remaining <= 0) throw this.activityError();
    const expired = Promise.withResolvers<never>();
    const cancel = this.clock.setTimer(() => expired.reject(this.activityError()), remaining);
    try {
      // One deadline covers all peers. Store contention and an evolving frame tail cannot
      // hold repository admission indefinitely. The actor keeps processing after refusal.
      await Promise.race([this.reconcile(id), expired.promise]);
    } finally {
      cancel();
    }
    if (this.active(id) || this.clock.now() >= deadline) throw this.activityError();
  }
  private assertIdle(id: ThreadId): void {
    if (this.active(id)) throw this.activityError();
  }
  private activityError(): GitError {
    return new GitError(
      "repository_agent_running",
      "An agent is running or its activity cannot settle in this repository; stop it or wait",
    );
  }
}
