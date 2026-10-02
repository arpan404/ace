import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { PluginInstall, PluginReview } from "@ace/protocol/plugins";

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
      CREATE TABLE IF NOT EXISTS installs (name TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);`);
    this.selects = {
      installs: this.db.prepare("SELECT data FROM installs ORDER BY name LIMIT 257"),
      reviews: this.db.prepare("SELECT data FROM reviews ORDER BY id LIMIT 33"),
      review: this.db.prepare("SELECT data FROM reviews WHERE id = ?"),
    };
    this.mutations = {
      install: this.db.prepare(
        "INSERT INTO installs VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data",
      ),
      review: this.db.prepare("INSERT INTO reviews VALUES (?, ?, ?)"),
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
    this.mutations.review.run(data.review.id, data.review.name, JSON.stringify(data));
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
