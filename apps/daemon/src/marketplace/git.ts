import { lstat, mkdir, opendir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseCatalog, type ArchiveFile, type ParsedCatalog } from "@ace/marketplace";
import {
  extractPlugin,
  fetchRepository,
  inspectPackage,
  readGitFile,
  type GitRuntime,
} from "@ace/plugins";

/*
 * A person-added git catalog (ADR 0168 §4), read with ADR 0014's fetcher: a shallow bare fetch
 * with isolated config and no hooks; blobs are read straight from it and nothing is checked out
 * or run. Each read fetches the catalog's default branch and pins the commit it found.
 */

const catalogFiles = [
  "marketplace.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
];

export class GitCatalogs {
  readonly #root: string;
  readonly #runtime: GitRuntime;
  readonly #id: () => string;

  constructor(options: { root: string; runtime: GitRuntime; id: () => string }) {
    this.#root = options.root;
    this.#runtime = options.runtime;
    this.#id = options.id;
  }

  async #fetched<T>(
    address: string,
    run: (gitRoot: string, commit: string, temporary: string) => Promise<T>,
  ): Promise<T> {
    const temporary = join(this.#root, `fetch-${this.#id().replace(/[^A-Za-z0-9-]/g, "")}`);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    let released = false;
    try {
      const { gitRoot, commit } = await fetchRepository(address, "HEAD", temporary, this.#runtime);
      const result = await run(gitRoot, commit, temporary);
      await this.#runtime.release(temporary);
      released = true;
      return result;
    } finally {
      try {
        if (!released) await this.#runtime.release(temporary);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }

  static async #catalog(
    gitRoot: string,
    commit: string,
    runtime: GitRuntime,
  ): Promise<ParsedCatalog> {
    for (const path of catalogFiles) {
      let text: string;
      try {
        text = await readGitFile(gitRoot, commit, path, runtime);
      } catch (error) {
        if (error instanceof Error && error.message.includes("does not exist")) continue;
        throw error;
      }
      if (text.length > 1024 * 1024) throw new Error(`${path} is over 1 MiB`);
      return parseCatalog(JSON.parse(text));
    }
    throw new Error("The repository has no marketplace.json");
  }

  /** The catalog at the default branch's current commit. */
  read(address: string): Promise<{ commit: string; catalog: ParsedCatalog }> {
    return this.#fetched(address, async (gitRoot, commit) => ({
      commit,
      catalog: await GitCatalogs.#catalog(gitRoot, commit, this.#runtime),
    }));
  }

  /**
   * One entry's folder at the current commit, with the catalog entry that names it. The folder
   * is extracted blob by blob into private staging (links and submodules refused), read into
   * memory and removed.
   */
  entry(
    address: string,
    type: string,
    name: string,
  ): Promise<{ commit: string; catalog: ParsedCatalog; files: ArchiveFile[]; hash: string }> {
    return this.#fetched(address, async (gitRoot, commit, temporary) => {
      const catalog = await GitCatalogs.#catalog(gitRoot, commit, this.#runtime);
      const entry = catalog.entries.find((item) => item.type === type && item.name === name);
      if (!entry) throw new Error(`The catalog no longer lists ${type}/${name}`);
      const stage = join(temporary, "entry");
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await extractPlugin(gitRoot, commit, entry.source, stage, this.#runtime);
      const digest = await inspectPackage(stage);
      if (entry.hash !== undefined && entry.hash !== digest.hash)
        throw new Error("The folder doesn't match the hash its catalog gives");
      const files: ArchiveFile[] = [];
      for (const file of digest.files) {
        const content = new Uint8Array(await readFile(join(stage, file.path)));
        files.push({ path: file.path, executable: file.executable, content });
      }
      return { commit, catalog, files, hash: digest.hash };
    });
  }

  /** Removes fetch folders a crash left behind. */
  async collect(): Promise<void> {
    try {
      await lstat(this.#root);
    } catch {
      return;
    }
    for await (const entry of await opendir(this.#root))
      if (entry.name.startsWith("fetch-"))
        await rm(join(this.#root, entry.name), { recursive: true, force: true });
  }
}
