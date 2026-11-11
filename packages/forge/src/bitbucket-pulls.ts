import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { bitbucketRepoPath, bktGet, nextEndpoint } from "./bkt-api.ts";
import { abbreviates, decode, pull, ref, sha, type Pull } from "./bitbucket-records.ts";

const commit = z.looseObject({ hash: sha });
const Newest = z.looseObject({ values: z.array(commit).max(100) });

export type BitbucketOptions = {
  repository: ForgeRepository;
  runner: CommandRunner;
  /** The pinned bkt context every request names (ADR 0118). */
  login: string;
};

/** A pull request with its head and base resolved from Bitbucket's abbreviated hashes. */
export type PinnedPull = { p: Pull; head: string; base: string };

/** Reads one repository's pull requests through the pinned bkt context. */
export class BitbucketPulls {
  readonly repository: ForgeRepository;
  readonly root: string;
  readonly options: BitbucketOptions;
  constructor(options: BitbucketOptions) {
    if (options.repository.forge !== "bitbucket") throw new ForgeError("unsupported");
    this.options = options;
    this.repository = options.repository;
    this.root = bitbucketRepoPath(options.repository);
  }
  get(endpoint: string, signal: AbortSignal): Promise<unknown> {
    return bktGet(this.options.runner, this.options.login, endpoint, signal);
  }
  /** Every row of a paged list, following `next` within `endpoint`, at most `max` rows. */
  async all<T>(endpoint: string, row: z.ZodType<T>, max: number, signal: AbortSignal) {
    const rows: T[] = [];
    const Page = z.looseObject({ values: z.array(row).max(100), next: z.string().optional() });
    let next: string | undefined = endpoint;
    for (let index = 0; next !== undefined; index++) {
      if (index === 20) throw new ForgeError("limit");
      const data = decode(Page, await this.get(next, signal));
      rows.push(...data.values);
      if (rows.length > max) throw new ForgeError("limit");
      next = nextEndpoint(data.next, next);
    }
    return rows;
  }
  async pull(number: number, signal: AbortSignal): Promise<Pull> {
    ref(this.repository, number);
    const p = decode(pull, await this.get(`${this.root}/pullrequests/${number}`, signal));
    if (p.id !== number) throw new ForgeError("invalid_data");
    return p;
  }
  /** The full commit an abbreviated hash names, in `repository`. */
  private async full(repository: ForgeRepository, short: string, signal: AbortSignal) {
    const c = decode(
      commit,
      await this.get(`${bitbucketRepoPath(repository)}/commit/${short}`, signal),
    );
    if (!abbreviates(short, c.hash)) throw new ForgeError("invalid_data");
    return c.hash;
  }
  /**
   * The pull request with full head and base commits. The head is the newest of the pull
   * request's own commits, which a fork's private repository can't hide; it must be the
   * commit the pull request names, or the read fails.
   */
  async pinned(number: number, signal: AbortSignal): Promise<PinnedPull> {
    const p = await this.pull(number, signal);
    const [newest, base] = await Promise.all([
      this.get(`${this.root}/pullrequests/${number}/commits?pagelen=1`, signal),
      this.full(this.repository, p.destination.commit.hash, signal),
    ]);
    const head = decode(Newest, newest).values[0]?.hash;
    if (!head || !abbreviates(p.source.commit.hash, head)) throw new ForgeError("head_moved");
    return { p, head, base };
  }
  /** Read again after a read that must describe `head`: refused once the head moved. */
  async still(number: number, head: string, signal: AbortSignal): Promise<Pull> {
    const p = await this.pull(number, signal);
    if (!abbreviates(p.source.commit.hash, head)) throw new ForgeError("head_moved");
    return p;
  }
}
