import { reviewSummary } from "./review-pages.ts";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  PluginAvailability,
  PluginInstall,
  PluginReview,
  PluginReviewSummary,
} from "@ace/protocol/plugins";

export const StoredReview = z.strictObject({
  review: PluginReview,
  repository: z.string().max(8192),
  ref: z.string().max(256),
});
export type StoredReview = z.infer<typeof StoredReview>;
export const StoredInstall = z.strictObject({
  install: PluginInstall,
  repository: z.string().max(8192),
  ref: z.string().max(256),
});
export type StoredInstall = z.infer<typeof StoredInstall>;
export class Registry {
  private db: DatabaseSync;
  private closed = false;
  private selects;
  private mutations;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS availability (name TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS installs (name TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, summary TEXT);`);
    const columns = this.db
      .prepare("PRAGMA table_info(reviews)")
      .all()
      .map((column) => z.string().parse(column.name));
    if (!columns.includes("summary")) this.db.exec("ALTER TABLE reviews ADD COLUMN summary TEXT");
    // Upgrade legacy rows once; listing never loads executable bodies into JavaScript.
    this.db.exec(`UPDATE reviews SET summary = json_object(
      'id', json_extract(data, '$.review.id'),
      'name', json_extract(data, '$.review.name'),
      'version', json_extract(data, '$.review.version'),
      'commit', json_extract(data, '$.review.commit'),
      'hash', json_extract(data, '$.review.hash'),
      'executionCount', json_array_length(data, '$.review.executions'),
      'unsupportedCount', json_array_length(data, '$.review.unsupported')
    ) WHERE summary IS NULL`);
    this.selects = {
      installs: this.db.prepare("SELECT data FROM installs ORDER BY name LIMIT 257"),
      reviews: this.db.prepare("SELECT data FROM reviews ORDER BY id LIMIT 33"),
      summaries: this.db.prepare("SELECT summary FROM reviews ORDER BY id LIMIT 33"),
      review: this.db.prepare("SELECT data FROM reviews WHERE id = ?"),
    };
    this.mutations = {
      install: this.db.prepare(
        "INSERT INTO installs VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data",
      ),
      review: this.db.prepare("INSERT INTO reviews (id, name, data, summary) VALUES (?, ?, ?, ?)"),
      remove: this.db.prepare("DELETE FROM installs WHERE name = ?"),
      deleteReview: this.db.prepare("DELETE FROM reviews WHERE id = ?"),
      deleteNamedReviews: this.db.prepare("DELETE FROM reviews WHERE name = ?"),
    };
  }
  installs(): StoredInstall[] {
    return this.selects.installs
      .all()
      .map((row) => StoredInstall.parse(JSON.parse(z.string().parse(row.data))));
  }
  availability(name: string): import("@ace/protocol/plugins").PluginAvailability | undefined {
    const row = this.db.prepare("SELECT data FROM availability WHERE name=?").get(name);
    return row ? PluginAvailability.parse(JSON.parse(z.string().parse(row.data))) : undefined;
  }
  configure(input: import("@ace/protocol/plugins").PluginAvailability): void {
    const value = PluginAvailability.parse(input);
    this.db
      .prepare(
        "INSERT INTO availability VALUES (?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data",
      )
      .run(value.name, JSON.stringify(value));
  }
  summaries(): PluginReviewSummary[] {
    return this.selects.summaries
      .all()
      .map((row) => PluginReviewSummary.parse(JSON.parse(z.string().parse(row.summary))));
  }
  reviews(): StoredReview[] {
    return this.selects.reviews
      .all()
      .map((row) => StoredReview.parse(JSON.parse(z.string().parse(row.data))));
  }
  review(id: string): StoredReview {
    const row = this.selects.review.get(id);
    if (!row) throw new Error("Review not found");
    return StoredReview.parse(JSON.parse(z.string().parse(row.data)));
  }
  saveReview(value: StoredReview): void {
    const data = StoredReview.parse(value);
    this.mutations.review.run(
      data.review.id,
      data.review.name,
      JSON.stringify(data),
      JSON.stringify(reviewSummary(data.review)),
    );
  }
  accept(value: StoredInstall, reviewId: string): void {
    this.transaction(() => {
      this.mutations.install.run(value.install.name, JSON.stringify(StoredInstall.parse(value)));
      this.mutations.deleteReview.run(reviewId);
    });
  }
  remove(name: string): void {
    this.transaction(() => {
      this.mutations.remove.run(name);
      this.db.prepare("DELETE FROM availability WHERE name=?").run(name);
      this.mutations.deleteNamedReviews.run(name);
    });
  }
  cancel(id: string): void {
    this.mutations.deleteReview.run(id);
  }
  private transaction(run: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
