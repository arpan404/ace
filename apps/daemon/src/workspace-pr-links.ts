import { ForgeStore, repositoryKey, prUrl, prFromUrl } from "@ace/forge";
import {
  ThreadId,
  type ForgePrRef,
  type ForgePrStatus,
  type LinkedPullRequest,
} from "@ace/protocol";
import type { Store } from "./store.ts";

/** Owns durable associations and the client projection that every link entry point publishes. */
export class WorkspacePrLinks {
  readonly links: ForgeStore;
  private store: Store;
  private now: () => number;
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    this.links = store.atomic((db) => new ForgeStore(db));
    this.migrateAgentLinks();
    store.atomic((db) => {
      for (const row of db
        .prepare(
          "SELECT DISTINCT thread_id FROM forge_links JOIN threads ON threads.id=thread_id WHERE json_extract(client,'$.details.linkedPrs') IS NULL",
        )
        .all())
        this.publish(ThreadId.parse(row.thread_id));
    });
  }
  private migrateAgentLinks(): void {
    this.store.atomic((db) => {
      if (
        !db
          .prepare("PRAGMA table_info(agent_thread_metadata)")
          .all()
          .some((row) => row.name === "pr_url")
      )
        return;
      for (const row of db
        .prepare("SELECT thread_id,pr_url FROM agent_thread_metadata WHERE pr_url IS NOT NULL")
        .all()) {
        if (typeof row.thread_id !== "string" || typeof row.pr_url !== "string") continue;
        try {
          const id = ThreadId.parse(row.thread_id);
          const thread = this.store.getThread(id);
          if (!thread || thread.deletedAt !== undefined) continue;
          this.links.link({ threadId: id, pr: prFromUrl(row.pr_url) });
          this.publish(id);
        } catch {
          /* Malformed historical metadata never blocks startup. */
        }
      }
      db.exec("ALTER TABLE agent_thread_metadata DROP COLUMN pr_url");
    });
  }
  publish(id: ThreadId): void {
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) return;
    const linkedPrs = this.links.summaries(id);
    const first = linkedPrs[0];
    const linkedPr = first
      ? {
          number: first.number,
          state: first.state === "draft" ? ("open" as const) : first.state,
          draft: first.state === "draft",
          url: first.url,
        }
      : null;
    if (
      JSON.stringify(thread.details?.linkedPrs) === JSON.stringify(linkedPrs) &&
      JSON.stringify(thread.details?.linkedPr) === JSON.stringify(linkedPr)
    )
      return;
    this.store.appendEvents(
      id,
      [
        {
          type: "thread.client.updated",
          changes: { details: { ...thread.details, linkedPrs, linkedPr } },
        },
      ],
      this.now(),
    );
  }
  update(id: ThreadId, status: ForgePrStatus, generation: number | undefined): void {
    if (
      generation === undefined ||
      this.links.getLinkState(id, status.ref)?.generation !== generation ||
      status.state === "unknown"
    )
      return;
    const previous = this.links
      .summaries(id)
      .find(
        (pr) =>
          pr.number === status.ref.number &&
          repositoryKey(pr.repo) === repositoryKey(status.ref.repository),
      );
    const summary: LinkedPullRequest = {
      number: status.ref.number,
      repo: status.ref.repository,
      state: status.state,
      url: status.url,
      title: status.title,
      updatedAt: previous?.updatedAt ?? this.now(),
    };
    // A refresh with identical facts produces no event and preserves its timestamp.
    const { updatedAt: _at, ...before } = previous ?? summary;
    const { updatedAt: _nextAt, ...after } = summary;
    if (JSON.stringify(before) !== JSON.stringify(after)) summary.updatedAt = this.now();
    this.links.update(id, summary, generation);
    this.publish(id);
  }
  fallback(pr: ForgePrRef, summary?: LinkedPullRequest): ForgePrStatus {
    return {
      ref: pr,
      title: summary?.title ?? "",
      url: summary?.url ?? prUrl(pr),
      state: summary?.unverified ? "unknown" : (summary?.state ?? "unknown"),
      headSha: "",
      mergeability: "unknown",
      ci: "unknown",
      checks: [],
      comments: [],
      reviewThreads: [],
      raw: { unverified: true },
    };
  }
  deleted(id: ThreadId, pr: ForgePrRef, generation: number): void {
    const previous = this.links
      .summaries(id)
      .find(
        (entry) =>
          entry.number === pr.number && repositoryKey(entry.repo) === repositoryKey(pr.repository),
      );
    this.links.update(
      id,
      {
        ...previous,
        number: pr.number,
        repo: pr.repository,
        url: previous?.url ?? prUrl(pr),
        state: "closed",
        updatedAt: previous?.deleted ? previous.updatedAt : this.now(),
        deleted: true,
        unverified: false,
      },
      generation,
    );
    this.publish(id);
  }
}
