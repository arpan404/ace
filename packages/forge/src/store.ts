import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ForgeThreadLink,
  ForgeAutoFixIntent,
  ForgeLinkState,
  ForgePrRef,
  LinkedPullRequest,
} from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";
import { redactData } from "./redact.ts";

const rowSchema = z.object({ payload: z.string() });
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const row = rowSchema.safeParse(value);
  if (!row.success) throw new ForgeError("invalid_data");
  try {
    return schema.parse(JSON.parse(row.data.payload));
  } catch {
    throw new ForgeError("invalid_data");
  }
}
/** Caller owns database lifetime. Tables are isolated from daemon migrations. */
export class ForgeStore {
  readonly #db: DatabaseSync;
  readonly #getLink;
  readonly #putLink;
  readonly #getLinks;
  readonly #seen;
  readonly #admit;
  readonly #pending;
  readonly #ack;
  readonly #discard;
  readonly #advance;
  readonly #adoptAccepted;
  readonly #retireAccepted;
  readonly #count;
  readonly #maxPending: number;
  constructor(db: DatabaseSync, maxPending = 2_000) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 2_000)
      throw new RangeError("Invalid queue cap");
    this.#db = db;
    this.#maxPending = maxPending;
    db.exec(`CREATE TABLE IF NOT EXISTS forge_links (thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forge_intents (thread_id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT, PRIMARY KEY(thread_id,key));
      CREATE INDEX IF NOT EXISTS forge_pending ON forge_intents(thread_id) WHERE payload IS NOT NULL;
      CREATE TABLE IF NOT EXISTS forge_link_epochs(thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO forge_link_epochs SELECT thread_id,1 FROM forge_links;`);
    const columns = db.prepare("PRAGMA table_info(forge_links)").all();
    if (!columns.some((column) => column.name === "repo")) {
      db.exec(`SAVEPOINT forge_migrate;
        ALTER TABLE forge_links RENAME TO forge_links_legacy;
        CREATE TABLE forge_links (thread_id TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
          payload TEXT NOT NULL, generation INTEGER NOT NULL, summary TEXT,
          PRIMARY KEY(thread_id,repo,number));
        INSERT INTO forge_links SELECT l.thread_id,json_extract(l.payload,'$.pr.repository'),
          json_extract(l.payload,'$.pr.number'),l.payload,e.generation,NULL
          FROM forge_links_legacy l JOIN forge_link_epochs e USING(thread_id);
        DROP TABLE forge_links_legacy;`);
      for (const row of db.prepare("SELECT rowid,payload FROM forge_links").all()) {
        const link = decode(ForgeThreadLink, row);
        const rowid = z.object({ rowid: z.number() }).parse(row).rowid;
        db.prepare("UPDATE forge_links SET repo=? WHERE rowid=?").run(
          repositoryKey(link.pr.repository),
          rowid,
        );
      }
      db.exec("RELEASE forge_migrate");
    }
    if (
      !db
        .prepare("PRAGMA table_info(forge_intents)")
        .all()
        .some((column) => column.name === "pr_key")
    ) {
      db.exec("SAVEPOINT forge_intent_migrate; ALTER TABLE forge_intents ADD COLUMN pr_key TEXT;");
      for (const row of db
        .prepare("SELECT thread_id,key,payload FROM forge_intents WHERE payload IS NOT NULL")
        .all()) {
        const intent = decode(ForgeAutoFixIntent, row);
        db.prepare("UPDATE forge_intents SET pr_key=? WHERE thread_id=? AND key=?").run(
          prKey(intent.link.pr),
          intent.link.threadId,
          intent.key,
        );
      }
      db.exec("RELEASE forge_intent_migrate");
    }
    this.#getLinks = db.prepare(
      "SELECT payload,generation,summary FROM forge_links WHERE thread_id=? ORDER BY generation DESC",
    );
    this.#getLink = db.prepare(
      "SELECT payload,generation FROM forge_links WHERE thread_id=? AND repo=? AND number=?",
    );
    this.#putLink = db.prepare(
      "INSERT INTO forge_links(thread_id,repo,number,payload,generation) VALUES (?,?,?,?,?)",
    );
    this.#seen = db.prepare("SELECT 1 FROM forge_intents WHERE thread_id=? AND key=?");
    this.#admit = db.prepare(
      "INSERT OR IGNORE INTO forge_intents(thread_id,key,payload,pr_key) VALUES (?,?,?,?)",
    );
    this.#pending = db.prepare(
      "SELECT payload FROM forge_intents WHERE thread_id=? AND payload IS NOT NULL ORDER BY rowid LIMIT 32",
    );
    this.#adoptAccepted = db.prepare(
      "INSERT INTO forge_intents(thread_id,key,payload,pr_key) SELECT thread_id,?,NULL,pr_key FROM forge_intents WHERE thread_id=? AND key=? AND payload IS NULL ON CONFLICT(thread_id,key) DO UPDATE SET payload=NULL",
    );
    this.#retireAccepted = db.prepare(
      "DELETE FROM forge_intents WHERE thread_id=? AND key=? AND payload IS NULL",
    );
    this.#advance = db.prepare(
      "INSERT INTO forge_link_epochs VALUES (?,1) ON CONFLICT(thread_id) DO UPDATE SET generation=generation+1",
    );
    this.#discard = db.prepare(
      "DELETE FROM forge_intents WHERE thread_id=? AND key=? AND payload IS NOT NULL",
    );
    this.#ack = db.prepare("UPDATE forge_intents SET payload=NULL WHERE thread_id=? AND key=?");
    this.#count = db.prepare(
      "SELECT count(*) AS count FROM forge_intents WHERE payload IS NOT NULL",
    );
  }
  link(input: ForgeThreadLink): void {
    const link = ForgeThreadLink.parse(input);
    if (this.getLinkState(link.threadId, link.pr)) return;
    if (this.getLinks(link.threadId).length >= 100) throw new ForgeError("limit");
    this.#db.exec("SAVEPOINT forge_link");
    try {
      this.#advance.run(link.threadId);
      const generation = z
        .object({ generation: z.number().int().positive() })
        .parse(
          this.#db
            .prepare("SELECT generation FROM forge_link_epochs WHERE thread_id=?")
            .get(link.threadId),
        ).generation;
      this.#putLink.run(
        link.threadId,
        repositoryKey(link.pr.repository),
        link.pr.number,
        JSON.stringify(link),
        generation,
      );
      this.#db.exec("RELEASE forge_link");
    } catch (error) {
      this.#db.exec("ROLLBACK TO forge_link; RELEASE forge_link");
      throw error;
    }
  }
  getLinks(threadId: string): ForgeLinkState[] {
    return this.#getLinks.all(threadId).map((row) => ({
      link: decode(ForgeThreadLink, row),
      generation: z.object({ generation: z.number().int().positive() }).parse(row).generation,
    }));
  }
  getLink(threadId: string): ForgeThreadLink | undefined {
    return this.getLinkState(threadId)?.link;
  }
  getLinkState(threadId: string, pr?: ForgePrRef): ForgeLinkState | undefined {
    if (!pr) return this.getLinks(threadId)[0];
    const row = this.#getLink.get(threadId, repositoryKey(pr.repository), pr.number);
    if (row === undefined) return undefined;
    const generation = z.object({ generation: z.number().int().positive() }).parse(row).generation;
    return { link: decode(ForgeThreadLink, row), generation };
  }
  summaries(threadId: string): LinkedPullRequest[] {
    return this.#getLinks.all(threadId).map((row) => {
      const summary = z.object({ summary: z.string().nullable() }).parse(row).summary;
      if (summary) return LinkedPullRequest.parse(JSON.parse(summary));
      const { pr } = decode(ForgeThreadLink, row);
      return {
        number: pr.number,
        repo: pr.repository,
        url: prUrl(pr),
        state: "open",
        updatedAt: 0,
        unverified: true,
      };
    });
  }
  update(threadId: string, pr: LinkedPullRequest, generation: number): void {
    const value = LinkedPullRequest.parse(pr);
    this.#db
      .prepare(
        "UPDATE forge_links SET summary=? WHERE thread_id=? AND repo=? AND number=? AND generation=?",
      )
      .run(JSON.stringify(value), threadId, repositoryKey(value.repo), value.number, generation);
  }
  unlink(threadId: string, pr?: ForgePrRef): void {
    this.#db.exec("SAVEPOINT forge_unlink");
    try {
      if (pr) {
        this.#db
          .prepare("DELETE FROM forge_intents WHERE thread_id=? AND pr_key=?")
          .run(threadId, prKey(pr));
        this.#db
          .prepare("DELETE FROM forge_links WHERE thread_id=? AND repo=? AND number=?")
          .run(threadId, repositoryKey(pr.repository), pr.number);
      } else {
        this.#db.prepare("DELETE FROM forge_intents WHERE thread_id=?").run(threadId);
        this.#db.prepare("DELETE FROM forge_links WHERE thread_id=?").run(threadId);
      }
      this.#db.exec("RELEASE forge_unlink");
    } catch (error) {
      this.#db.exec("ROLLBACK TO forge_unlink; RELEASE forge_unlink");
      throw error;
    }
  }
  hasIntent(threadId: string, key: string): boolean {
    return this.#seen.get(threadId, key) !== undefined;
  }
  /** Adopt only acknowledged legacy identities, then retire the ambiguous old digest. */
  adoptAccepted(threadId: string, legacyKey: string, key: string): boolean {
    this.#db.exec("SAVEPOINT forge_adopt");
    try {
      this.#adoptAccepted.run(key, threadId, legacyKey);
      const result = this.#retireAccepted.run(threadId, legacyKey);
      this.#db.exec("RELEASE forge_adopt");
      return Number(result.changes) > 0;
    } catch (error) {
      this.#db.exec("ROLLBACK TO forge_adopt; RELEASE forge_adopt");
      throw error;
    }
  }
  admit(input: ForgeAutoFixIntent): void {
    const intent = ForgeAutoFixIntent.parse(redactData(input));
    if (this.hasIntent(intent.link.threadId, intent.key)) return;
    const count = z.object({ count: z.number() }).parse(this.#count.get()).count;
    if (count >= this.#maxPending) throw new ForgeError("limit");
    const state = this.getLinkState(intent.link.threadId, intent.link.pr);
    if (
      state?.generation !== intent.linkGeneration ||
      JSON.stringify(state.link) !== JSON.stringify(intent.link)
    )
      throw new ForgeError("conflict");
    this.#admit.run(
      intent.link.threadId,
      intent.key,
      JSON.stringify(intent),
      prKey(intent.link.pr),
    );
  }
  pending(threadId: string, pr?: ForgePrRef): ForgeAutoFixIntent[] {
    if (pr)
      return this.#db
        .prepare(
          "SELECT payload FROM forge_intents WHERE thread_id=? AND payload IS NOT NULL AND pr_key=? ORDER BY rowid LIMIT 32",
        )
        .all(threadId, prKey(pr))
        .map((row) => decode(ForgeAutoFixIntent, row));
    return this.#pending.all(threadId).map((row) => decode(ForgeAutoFixIntent, row));
  }
  discard(intent: ForgeAutoFixIntent): void {
    this.#discard.run(intent.link.threadId, intent.key);
  }
  acknowledge(intent: ForgeAutoFixIntent): void {
    this.#ack.run(intent.link.threadId, intent.key);
  }
}

/** Canonical key also keeps repository identity insensitive to GitHub URL case. */
export function repositoryKey(repo: ForgePrRef["repository"]): string {
  return JSON.stringify({
    forge: repo.forge,
    host: repo.host.toLowerCase(),
    owner: repo.owner.toLowerCase(),
    name: repo.name.toLowerCase(),
  });
}
export function prUrl(pr: ForgePrRef): string {
  const repo = pr.repository;
  return `https://${repo.host}/${repo.owner}/${repo.name}/${repo.forge === "github" ? "pull" : "-/merge_requests"}/${pr.number}`;
}

function prKey(pr: ForgePrRef): string {
  return `${repositoryKey(pr.repository)}:${pr.number}`;
}
