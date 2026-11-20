import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { MarketInstalled } from "@ace/protocol/marketplace";
import {
  contentHash,
  hashFiles,
  readArchive,
  typeLimits,
  writeArchive,
  type ArchiveFile,
  type FeedEntry,
  type HashedFile,
} from "@ace/marketplace";
import {
  storedMarketInstall,
  storedMarketProvenance,
  storedMarketJournal,
  storedMarketListing,
  storedMarketSource,
} from "../stored-decode.ts";
import { journalHashes, type Journal } from "./journal.ts";

/*
 * The daemon's marketplace registry (ADR 0168 §6): its sources, what the person accepted, and
 * the accepted bytes pinned by content hash, checked again on every read so nothing the Worker
 * later serves can change them. Listings are cached as files beside it, one per source.
 */

export interface StoredSource {
  id: string;
  kind: "market" | "git";
  address: string;
  enabled: boolean;
  readAt?: number | undefined;
  problem?: string | undefined;
  /** The market's index stamp and ETag, for the next `since` read. */
  stamp?: number | undefined;
  etag?: string | undefined;
  /** A git catalog's commit at the last read. */
  commit?: string | undefined;
}

export interface StoredInstall extends MarketInstalled {
  files: HashedFile[];
  /** A skill's description, as Spade lists it. */
  description: string;
  /** The plugin manager's pin for an accepted plugin. */
  pluginCommit?: string | undefined;
  /** A skill a recipe brought in its own folder: `spade-bot/<recipe>`. */
  bundledBy?: string | undefined;
  /**
   * Where these bytes came from (ADR 0178 §12.8): whether their manifest was signed, and by
   * which publisher. With `source`, an update may skip the person only from the same place.
   * Absent on records from before it, whose provenance is unknown.
   */
  signed?: boolean | undefined;
  publisher?: string | undefined;
  /**
   * For a linked bot: the market's signed manifest of the installed version, and of the one it
   * had before, so an update or a rollback proves its identity to Spade with no network.
   */
  signedManifest?: unknown;
  previousSignedManifest?: unknown;
  /**
   * For a Spade skill: the hash the person turned on for their bots. `null` when no one with the
   * person's standing has, so no bot sees it; absent on records from before it, which a person
   * installed and which stay on.
   */
  approvedHash?: string | null | undefined;
}

/** Where an entry's bytes came from, as an install or its removal keeps it. */
export type Provenance = Pick<StoredInstall, "source" | "signed" | "publisher">;

/** Whether the person turned this very installed version on for their bots. */
export function approvedForBots(install: StoredInstall): boolean {
  return install.approvedHash === undefined || install.approvedHash === install.hash;
}

/** Whether Spade may give this installed skill to bots: on, and this very version approved. */
export function onForBots(install: StoredInstall): boolean {
  return install.state === "on" && approvedForBots(install);
}

export interface StoredListing {
  entries: FeedEntry[];
  categories: { id: string; title: string }[];
  featured: { type: string; name: string }[];
  /** A git catalog's entry folders and hashes, by `type/name`. */
  folders?:
    | Record<string, { source: string; hash?: string | undefined; description: string }>
    | undefined;
}

const verifiedLimit = 2048;

/** The verified-publisher cache's key for one entry version. */
export const verifiedKey = (entry: { type: string; name: string; version: string }) =>
  `${entry.type}/${entry.name}@${entry.version}`;

export class MarketStore {
  readonly #db: DatabaseSync;
  readonly #root: string;

  private constructor(root: string, db: DatabaseSync) {
    this.#root = root;
    this.#db = db;
  }

  static async open(root: string): Promise<MarketStore> {
    await mkdir(join(root, "objects"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "listings"), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(root, "registry.sqlite"));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS installs (type TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (type, name));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verified_publishers (key TEXT PRIMARY KEY, publisher TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS removed_installs (type TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (type, name));`);
    return new MarketStore(root, db);
  }

  close(): void {
    this.#db.close();
  }

  sources(): StoredSource[] {
    return this.#db
      .prepare("SELECT data FROM sources ORDER BY id")
      .all()
      .map((row) => storedMarketSource(String(row["data"])));
  }

  source(id: string): StoredSource | undefined {
    const row = this.#db.prepare("SELECT data FROM sources WHERE id = ?").get(id);
    return row ? storedMarketSource(String(row["data"])) : undefined;
  }

  saveSource(source: StoredSource): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO sources (id, data) VALUES (?, ?)")
      .run(source.id, JSON.stringify(source));
  }

  async removeSource(id: string): Promise<void> {
    this.#db.prepare("DELETE FROM sources WHERE id = ?").run(id);
    await rm(this.#listingPath(id), { force: true });
  }

  #listingPath(id: string): string {
    return join(this.#root, "listings", `${id.replace(":", "-")}.json`);
  }

  async listing(id: string): Promise<StoredListing> {
    try {
      return storedMarketListing(await readFile(this.#listingPath(id), "utf8"));
    } catch {
      return { entries: [], categories: [], featured: [] };
    }
  }

  async saveListing(id: string, listing: StoredListing): Promise<void> {
    const path = this.#listingPath(id);
    await writeFile(`${path}.writing`, JSON.stringify(listing), { mode: 0o600 });
    await rename(`${path}.writing`, path);
  }

  installs(): StoredInstall[] {
    return this.#db
      .prepare("SELECT data FROM installs ORDER BY type, name")
      .all()
      .map((row) => storedMarketInstall(String(row["data"])));
  }

  install(type: string, name: string): StoredInstall | undefined {
    const row = this.#db
      .prepare("SELECT data FROM installs WHERE type = ? AND name = ?")
      .get(type, name);
    return row ? storedMarketInstall(String(row["data"])) : undefined;
  }

  saveInstall(install: StoredInstall): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO installs (type, name, data) VALUES (?, ?, ?)")
      .run(install.type, install.name, JSON.stringify(install));
  }

  removeInstall(type: string, name: string): void {
    this.#db.prepare("DELETE FROM installs WHERE type = ? AND name = ?").run(type, name);
  }

  /**
   * The person or a caller removed `install`: its row goes, and where its bytes came from stays
   * behind (ADR 0178 §12.8), so a later install of the same type and name is judged against it
   * as an update would be. Removing doesn't make a name a first install again.
   */
  removeInstallKeepingProvenance(install: StoredInstall): void {
    const kept: Provenance = {
      source: install.source,
      ...(install.signed === undefined ? {} : { signed: install.signed }),
      ...(install.publisher === undefined ? {} : { publisher: install.publisher }),
    };
    this.#db
      .prepare("INSERT OR REPLACE INTO removed_installs (type, name, data) VALUES (?, ?, ?)")
      .run(install.type, install.name, JSON.stringify(kept));
    this.removeInstall(install.type, install.name);
  }

  /**
   * Where the entry of `type` and `name` last came from: the installed record, else the one
   * left by its removal; undefined for a name never installed here.
   */
  provenance(type: string, name: string): Provenance | undefined {
    const installed = this.install(type, name);
    if (installed) return installed;
    const row = this.#db
      .prepare("SELECT data FROM removed_installs WHERE type = ? AND name = ?")
      .get(type, name);
    return row ? storedMarketProvenance(String(row["data"])) : undefined;
  }

  /** Installs that started and didn't finish: each step written down before it was taken. */
  journals(): Journal[] {
    return this.#db
      .prepare("SELECT data FROM journal ORDER BY id")
      .all()
      .map((row) => storedMarketJournal(String(row["data"])));
  }

  saveJournal(journal: Journal): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO journal (id, data) VALUES (?, ?)")
      .run(journal.id, JSON.stringify(journal));
  }

  dropJournal(id: string): void {
    this.#db.prepare("DELETE FROM journal WHERE id = ?").run(id);
  }

  meta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? String(row["value"]) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  /**
   * Who a signed manifest this device verified names as an entry version's publisher, by
   * `type/name@version` (`verifiedKey`). Only these ids earn a row "By ace" or "Verified".
   */
  verifiedPublishers(): Map<string, string> {
    return new Map(
      this.#db
        .prepare("SELECT key, publisher FROM verified_publishers")
        .all()
        .map((row) => [String(row["key"]), String(row["publisher"])] as const),
    );
  }

  /** Records a verified manifest's publisher; the cache keeps the newest `verifiedLimit`. */
  saveVerifiedPublisher(key: string, publisher: string): void {
    this.#db.prepare("DELETE FROM verified_publishers WHERE key = ?").run(key);
    this.#db
      .prepare("INSERT INTO verified_publishers (key, publisher) VALUES (?, ?)")
      .run(key, publisher);
    this.#db
      .prepare(
        "DELETE FROM verified_publishers WHERE rowid <= (SELECT MAX(rowid) FROM verified_publishers) - ?",
      )
      .run(verifiedLimit);
  }

  #objectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Not a content hash");
    return join(this.#root, "objects", `${hash}.tar`);
  }

  /** Pins accepted bytes under their content hash, written once. */
  async pin(
    hash: string,
    type: keyof typeof typeLimits,
    files: readonly ArchiveFile[],
  ): Promise<void> {
    if (contentHash(hashFiles(files)) !== hash) throw new Error("The bytes don't match their hash");
    const path = this.#objectPath(hash);
    try {
      await this.pinned(hash, type);
      return;
    } catch {
      // Not pinned yet, or damaged: write it again.
    }
    await writeFile(`${path}.writing`, writeArchive(files), { mode: 0o600 });
    await rename(`${path}.writing`, path);
  }

  /** The pinned bytes of `hash`, refused unless they still hash to it. */
  async pinned(hash: string, type: keyof typeof typeLimits): Promise<ArchiveFile[]> {
    const files = readArchive(
      new Uint8Array(await readFile(this.#objectPath(hash))),
      typeLimits[type],
    );
    if (contentHash(hashFiles(files)) !== hash)
      throw new Error("The pinned bytes changed; they no longer match what was accepted");
    return files;
  }

  /** Drops pinned bytes no install still names. */
  async collect(): Promise<void> {
    // Bytes an unfinished install may need to put back stay too.
    const keep = new Set(
      [
        ...this.installs().map((install) => install.hash),
        // A linked bot's earlier version stays, so a rollback needs no network (ADR 0200).
        ...this.installs().flatMap((install) => (install.previous ? [install.previous.hash] : [])),
        ...this.journals().flatMap(journalHashes),
      ].map((hash) => `${hash}.tar`),
    );
    for (const name of await readdir(join(this.#root, "objects")))
      if (!keep.has(name)) await rm(join(this.#root, "objects", name), { force: true });
  }
}
