import { repositoryKey } from "@ace/forge";
import { ForgeIssueRef, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

/** One indexed owner for source issues, shared by admission and explicit attachment. */
export class WorkspaceIssueLinks {
  readonly #store: Store;
  constructor(store: Store) {
    this.#store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS forge_issue_links (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      repo TEXT NOT NULL, number INTEGER NOT NULL, value JSON NOT NULL,
      PRIMARY KEY(thread_id,repo,number));
      CREATE INDEX IF NOT EXISTS forge_issue_repository_links ON forge_issue_links(repo,number,thread_id)`),
    );
  }
  link(id: ThreadId, input: ForgeIssueRef, at: number) {
    const issue = ForgeIssueRef.parse(input);
    this.#store.atomic((db) => {
      const thread = this.#store.getThread(id);
      if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
      const exists = db
        .prepare("SELECT 1 FROM forge_issue_links WHERE thread_id=? AND repo=? AND number=?")
        .get(id, repositoryKey(issue.repository), issue.number);
      if (exists) return;
      const count = db
        .prepare("SELECT count(*) AS n FROM forge_issue_links WHERE thread_id=?")
        .get(id);
      if (Number(count?.n ?? 0) >= 100) throw new Error("forge_limit");
      db.prepare("INSERT INTO forge_issue_links VALUES(?,?,?,?)").run(
        id,
        repositoryKey(issue.repository),
        issue.number,
        JSON.stringify(issue),
      );
      const linkedIssues = db
        .prepare("SELECT value FROM forge_issue_links WHERE thread_id=? ORDER BY repo,number")
        .all(id)
        .map((row) => ForgeIssueRef.parse(JSON.parse(String(row.value))));
      this.#store.appendEvents(
        id,
        [
          {
            type: "thread.client.updated",
            changes: { details: { ...thread.details, linkedIssues } },
          },
        ],
        at,
      );
    });
  }
  related(issue: ForgeIssueRef) {
    const rows = this.#store.atomic((db) =>
      db
        .prepare(
          "SELECT threads.id FROM forge_issue_links JOIN threads ON threads.id=thread_id WHERE repo=? AND number=? AND json_extract(client,'$.deletedAt') IS NULL ORDER BY threads.updated_at DESC LIMIT 101",
        )
        .all(repositoryKey(issue.repository), issue.number),
    );
    const threads = rows.flatMap((row) => {
      const thread = this.#store.getThread(ThreadId.parse(row.id));
      return thread ? [thread] : [];
    });
    return {
      relatedThreads: threads
        .slice(0, 100)
        .map((thread) => ({
          id: thread.id,
          title: thread.title,
          archived: thread.archivedAt !== undefined,
        })),
      relatedThreadsTruncated: threads.length > 100,
    };
  }
}
