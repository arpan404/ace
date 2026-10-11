import { z } from "zod";
import {
  ForgeHostedReviewCommand,
  ForgeReviewAction,
  ForgeReviewDraft,
  type ForgePrRef,
  type ForgeReviewState,
} from "@ace/protocol";
import { ForgeError, type GitHubForge } from "@ace/forge";
import type { Store } from "./store.ts";
const scope = (pr: ForgePrRef) => JSON.stringify(pr);
/** Local draft and remote-write journal. No agent or local review-session state is touched. */
export class WorkspaceForgeReviews {
  readonly #store: Store;
  constructor(store: Store) {
    this.#store = store;
    store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS forge_hosted_drafts (scope TEXT NOT NULL, id TEXT NOT NULL, draft TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS forge_hosted_writes (id TEXT PRIMARY KEY, scope TEXT NOT NULL, action TEXT NOT NULL, drafts TEXT NOT NULL, state TEXT NOT NULL);
    `),
    );
  }
  #drafts(pr: ForgePrRef) {
    return this.#store
      .atomic((db) =>
        db
          .prepare("SELECT draft FROM forge_hosted_drafts WHERE scope=? ORDER BY id LIMIT 101")
          .all(scope(pr)),
      )
      .map((row) => ForgeReviewDraft.parse(JSON.parse(z.string().parse(row.draft))));
  }
  #accepted(id: string, pr: ForgePrRef, drafts: ForgeReviewDraft[]) {
    this.#store.atomic((db) => {
      db.prepare("UPDATE forge_hosted_writes SET state='accepted' WHERE id=?").run(id);
      for (const draft of drafts)
        db.prepare("DELETE FROM forge_hosted_drafts WHERE scope=? AND id=? AND draft=?").run(
          scope(pr),
          draft.id,
          JSON.stringify(draft),
        );
    });
  }
  async state(
    pr: ForgePrRef,
    backend: GitHubForge,
    signal: AbortSignal,
  ): Promise<ForgeReviewState> {
    const host = await backend.reviews.host(pr.number, signal);
    let viewed: ForgeReviewState["viewed"] = null;
    try {
      viewed = await backend.reviews.viewed(pr.number, host.pr.headRefOid, signal);
    } catch (error) {
      if (signal.aborted || (error instanceof ForgeError && error.kind === "conflict")) throw error;
    }
    const drafts = this.#drafts(pr);
    if (drafts.length > 100) throw new ForgeError("limit");
    const operations = this.#store
      .atomic((db) =>
        db
          .prepare(
            "SELECT id,state FROM forge_hosted_writes WHERE scope=? ORDER BY rowid DESC LIMIT 100",
          )
          .all(scope(pr)),
      )
      .map((row) =>
        z.object({ id: z.string(), state: z.enum(["accepted", "uncertain"]) }).parse(row),
      );
    return {
      viewer: host.viewer,
      headSha: host.pr.headRefOid,
      drafts,
      viewed,
      canReview: host.pr.state === "OPEN" && host.pr.viewerCanComment && !host.pr.viewerDidAuthor,
      canComment: host.pr.viewerCanComment,
      resolvableThreads: host.threads
        .filter((t) => (t.isResolved ? t.viewerCanUnresolve : t.viewerCanResolve))
        .map((t) => t.id),
      operations,
    };
  }
  async execute(
    input: unknown,
    commandId: string,
    backend: GitHubForge,
    signal: AbortSignal,
    allowed: () => boolean,
  ) {
    const { pr, action } = ForgeHostedReviewCommand.parse(input);
    if (!allowed()) throw new ForgeError("cancelled");
    if (action.kind === "draft.save") {
      this.#store.atomic((db) => {
        const count = z
          .object({ count: z.number() })
          .parse(
            db
              .prepare("SELECT COUNT(*) AS count FROM forge_hosted_drafts WHERE scope=?")
              .get(scope(pr)),
          ).count;
        const exists = db
          .prepare("SELECT id FROM forge_hosted_drafts WHERE scope=? AND id=?")
          .get(scope(pr), action.draft.id);
        if (!exists && count >= 100) throw new ForgeError("limit");
        db.prepare(
          "INSERT INTO forge_hosted_drafts VALUES (?,?,?) ON CONFLICT(scope,id) DO UPDATE SET draft=excluded.draft",
        ).run(scope(pr), action.draft.id, JSON.stringify(action.draft));
      });
      return;
    }
    if (action.kind === "draft.delete") {
      this.#store.atomic((db) =>
        db
          .prepare("DELETE FROM forge_hosted_drafts WHERE scope=? AND id=?")
          .run(scope(pr), action.id),
      );
      return;
    }
    if (action.kind === "reconcile") {
      const row = this.#store.atomic((db) =>
        db
          .prepare("SELECT action,drafts FROM forge_hosted_writes WHERE id=? AND scope=?")
          .get(action.operationId, scope(pr)),
      );
      if (!row) throw new ForgeError("not_found");
      const original = ForgeReviewAction.parse(JSON.parse(z.string().parse(row.action)));
      const drafts = z
        .array(ForgeReviewDraft)
        .max(100)
        .parse(JSON.parse(z.string().parse(row.drafts)));
      if (!(await backend.reviews.reconcile(pr.number, original, action.operationId, signal)))
        throw new Error("action_outcome_uncertain");
      this.#accepted(action.operationId, pr, drafts);
      return;
    }
    const drafts =
      action.kind === "submit"
        ? this.#drafts(pr).filter((d) => action.draftIds.includes(d.id))
        : [];
    // A new command must not repeat an identical unresolved write after reconnect.
    const encoded = JSON.stringify(action);
    const previous = this.#store.atomic((db) =>
      db
        .prepare(
          "SELECT id FROM forge_hosted_writes WHERE scope=? AND action=? AND state='uncertain' LIMIT 1",
        )
        .get(scope(pr), encoded),
    );
    if (previous) throw new Error("action_outcome_uncertain");
    const unresolved = this.#store.atomic((db) =>
      db
        .prepare(
          "SELECT action FROM forge_hosted_writes WHERE scope=? AND state='uncertain' LIMIT 101",
        )
        .all(scope(pr)),
    );
    if (unresolved.length >= 100) throw new ForgeError("limit");
    if (
      action.kind === "submit" &&
      unresolved.some((row) => {
        const prior = ForgeReviewAction.parse(JSON.parse(z.string().parse(row.action)));
        return prior.kind === "submit" && prior.draftIds.some((id) => action.draftIds.includes(id));
      })
    )
      throw new Error("action_outcome_uncertain");
    this.#store.atomic((db) =>
      db
        .prepare("INSERT INTO forge_hosted_writes VALUES (?,?,?,?,'uncertain')")
        .run(commandId, scope(pr), encoded, JSON.stringify(drafts)),
    );
    try {
      await backend.reviews.write(pr.number, action, drafts, commandId, signal, allowed);
      this.#accepted(commandId, pr, drafts);
    } catch (error) {
      // HTTP refusals establish that GitHub rejected this write. Transport loss does not.
      if (
        error instanceof ForgeError &&
        ["forbidden", "not_found", "conflict", "unsupported"].includes(error.kind)
      ) {
        this.#store.atomic((db) =>
          db.prepare("DELETE FROM forge_hosted_writes WHERE id=?").run(commandId),
        );
        throw error;
      }
      if (!signal.aborted) {
        try {
          if (await backend.reviews.reconcile(pr.number, action, commandId, signal)) {
            this.#accepted(commandId, pr, drafts);
            return;
          }
        } catch {
          /* Keep the durable uncertainty visible until a successful reconciliation. */
        }
      }
      throw new Error("action_outcome_uncertain", { cause: error });
    }
  }
}
