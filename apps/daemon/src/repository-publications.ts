import {
  publicationIntent,
  publicationRemoteMatches,
  publicationError,
} from "./publication-state.ts";
import { z } from "zod";
import { GitHubRepositories, ForgeMutationOutcome } from "@ace/forge";
import {
  HostedRepository,
  RepositoryPublication,
  RepositoryPublishInput,
  type WorkspaceId,
} from "@ace/protocol";
import { publicationOriginMatches, type GitService, type ProjectGitPolicy } from "@ace/git";
import type { Store } from "./store.ts";
import type { SourceControl } from "./source-control.ts";
import type { ProjectDirectory } from "./project-directory.ts";

const saved = z.object({ device: z.string(), publication: RepositoryPublication });
/** One durable intent per local project. A dispatched create is never repeated. */
export class RepositoryPublications {
  private store: Store;
  private source: SourceControl;
  private now: () => number;
  private flights = new Map<string, { device: string; controller: AbortController }>();
  constructor(store: Store, source: SourceControl, now: () => number) {
    this.store = store;
    this.source = source;
    this.now = now;
    store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS repository_publications (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), record TEXT NOT NULL)",
      ),
    );
  }
  private record(id: WorkspaceId) {
    const row = this.store
      .statement("SELECT record FROM repository_publications WHERE workspace_id=?")
      .get(id);
    return row ? saved.parse(JSON.parse(z.string().parse(row.record))) : null;
  }
  status(id: WorkspaceId): RepositoryPublication | null {
    return this.record(id)?.publication ?? null;
  }
  private save(device: string, publication: RepositoryPublication): void {
    publication.updatedAt = this.now();
    const record = saved.parse({ device, publication });
    this.store
      .statement(
        "INSERT INTO repository_publications VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET record=excluded.record",
      )
      .run(publication.workspaceId, JSON.stringify(record));
  }
  cancel(id: WorkspaceId, device: string): void {
    const flight = this.flights.get(id);
    if (!flight) throw new Error("publication_not_running");
    if (flight.device !== device) throw new Error("forbidden");
    flight.controller.abort();
  }
  cancelDevice(device: string): void {
    for (const flight of this.flights.values())
      if (flight.device === device) flight.controller.abort();
  }
  close(): void {
    for (const flight of this.flights.values()) flight.controller.abort();
  }
  async publish(
    id: WorkspaceId,
    device: string,
    input: RepositoryPublishInput,
    directory: ProjectDirectory,
    git: GitService,
    allowed: () => boolean,
    policy?: ProjectGitPolicy,
  ): Promise<RepositoryPublication> {
    if (this.flights.has(id)) throw new Error("publication_busy");
    if (this.flights.size >= 4) throw new Error("publication_busy");
    const value = RepositoryPublishInput.parse(input);
    const publication = publicationIntent(this.record(id), device, value, id, this.now());
    const controller = new AbortController();
    this.flights.set(id, { device, controller });
    const signal = controller.signal;
    let checkIdentity: (() => void) | undefined;
    const check = () => {
      signal.throwIfAborted();
      checkIdentity?.();
      if (!allowed()) throw new Error("forbidden");
      directory.verify();
    };
    try {
      check();
      const identity = await this.source.identity(directory.path, value.host, signal);
      checkIdentity = identity.check;
      check();
      if (identity.account !== value.account) throw new Error("publication_account_changed");
      check();
      const remote = new GitHubRepositories({
        host: value.host,
        account: value.account,
        runner: identity.runner,
        now: this.now,
      });
      const gitInput = { worktree: directory.path, directoryFd: directory.handle.fd, signal };
      const info = await git.publicationInfo(gitInput);
      check();
      if (info.root !== directory.path) throw new Error("publication_requires_repo_root");
      const origin = info.remotes.find((entry) => entry.name === "origin");
      if (
        origin &&
        (!publication.remote ||
          !publicationOriginMatches(info.remotes, publication.remote.cloneUrl))
      )
        throw new Error("publication_origin_exists");
      this.save(device, publication);
      let uncertain: ForgeMutationOutcome | undefined;
      if (publication.phase === "prepared") {
        const found = await remote.find(value.owner, value.name, signal);
        check();
        if (found) throw new Error("publication_name_taken");
        publication.phase = "creating";
        publication.error = null;
        this.save(device, publication);
        // Intent is durable before admission; even a lost CLI response must use exact-name lookup.
        try {
          publication.remote = await remote.create(value, signal);
        } catch (error) {
          if (!(error instanceof ForgeMutationOutcome)) {
            // The shared transport confirms that no write was dispatched (or HTTP rejected it).
            // Release the creation reservation and preserve the failure so the form can retry.
            publication.phase = "prepared";
            this.save(device, publication);
            throw error;
          }
          const receipt = HostedRepository.safeParse(error.receipt);
          if (receipt.success) {
            publication.remote = receipt.data;
            uncertain = error;
          } else {
            // The writer has settled before lookup begins; the workspace flight still owns
            // both reconciliation and receipt cleanup, preventing a concurrent create.
            try {
              check();
              publication.remote = await remote.find(value.owner, value.name, signal);
              check();
            } catch {
              throw error;
            }
            if (!publication.remote) throw error;
          }
        }
      } else if (publication.phase === "creating") {
        publication.remote = await remote.find(value.owner, value.name, signal);
      }
      if (!publication.remote) throw new Error("publication_creation_uncertain");
      const created = publication.remote;
      if (!publicationRemoteMatches(value, created)) throw new Error("publication_remote_mismatch");
      // The immutable created identity is committed before any local remote or push effect.
      if (publication.phase === "creating") {
        publication.phase = "remote_created";
        this.save(device, publication);
      }
      if (uncertain) throw uncertain;
      check();
      const reconciled = await remote.find(value.owner, value.name, signal);
      check();
      if (
        !reconciled ||
        reconciled.id !== created.id ||
        !publicationRemoteMatches(value, reconciled)
      )
        throw new Error("publication_remote_changed");
      await git.attachPublicationOrigin({ ...gitInput, url: created.cloneUrl });
      check();
      publication.phase = "origin_added";
      publication.error = null;
      this.save(device, publication);
      try {
        publication.phase = await git.pushPublication(
          { ...gitInput, url: created.cloneUrl },
          policy,
        );
      } catch {
        signal.throwIfAborted();
        throw new Error("publication_git_transport_failed");
      }
      check();
      this.save(device, publication);
      return publication;
    } catch (error) {
      publication.error = signal.aborted ? "publication_cancelled" : publicationError(error);
      this.save(device, publication);
      return publication;
    } finally {
      this.flights.delete(id);
    }
  }
}
