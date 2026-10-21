import { z } from "zod";
import type { ForgeFile } from "@ace/protocol/forge-browser";
import { FileRecord } from "./github-browser-schemas.ts";
import { ForgeError } from "./errors.ts";
import { both, gitOrder, treeChanges, type TreeChange } from "./github-tree-changes.ts";
import type { GhApi } from "./http.ts";

/** GitHub lists a pull request's first 3,000 files: 120 pages of 25. */
export const listedPages = 120;
const perPage = 25;
const lastPage = 4_000;

/**
 * A pull request's files past the 3,000 GitHub lists, as pages 121 on. GitHub lists files in
 * git's path order, so the rest are the changed paths that sort after its last listed one.
 * Their patches are never listed: each reads `patch: null` and is diffed from content on demand.
 * The comparison is kept per merge base and head, which never change.
 */
export class GitHubFileOverflow {
  readonly #api: GhApi;
  readonly #root: string;
  readonly #known = new Map<string, { changes: TreeChange[]; complete: boolean }>();
  constructor(api: GhApi, root: string) {
    this.#api = api;
    this.#root = root;
  }
  async page(
    input: { number: number; base: string; head: string; page: number },
    signal: AbortSignal,
  ): Promise<{ files: ForgeFile[]; nextPage?: number; complete: boolean }> {
    if (input.page <= listedPages) throw new ForgeError("invalid_data");
    const rest = await this.#rest(input, signal);
    const start = (input.page - listedPages - 1) * perPage;
    const files = rest.changes.slice(start, start + perPage).map((change): ForgeFile => ({
      raw: { tree: change },
      path: change.path,
      status: change.status,
      additions: 0,
      deletions: 0,
      patch: null,
      truncated: true,
    }));
    const more = start + perPage < rest.changes.length;
    return {
      files,
      ...(more && input.page < lastPage ? { nextPage: input.page + 1 } : {}),
      complete: rest.complete && (!more || input.page < lastPage),
    };
  }
  async #rest(input: { number: number; base: string; head: string }, signal: AbortSignal) {
    const key = `${input.number}:${input.base}...${input.head}`;
    const known = this.#known.get(key);
    if (known) return known;
    const [listed, compared] = await both(
      this.#api.request(
        `${this.#root}/pulls/${input.number}/files?per_page=${perPage}&page=${listedPages}`,
        signal,
      ),
      treeChanges(this.#api, this.#root, input.base, input.head, signal),
    );
    const records = z.array(FileRecord).max(perPage).safeParse(listed.body);
    if (!records.success) throw new ForgeError("invalid_data");
    const last = records.data.at(-1)?.filename;
    if (last === undefined) throw new ForgeError("conflict");
    const rest = {
      changes: compared.changes.filter((change) => gitOrder(change.path, last) > 0),
      complete: compared.complete,
    };
    this.#known.set(key, rest);
    if (this.#known.size > 4) {
      const oldest = this.#known.keys().next().value;
      if (oldest !== undefined) this.#known.delete(oldest);
    }
    return rest;
  }
}
