import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import { ForgePrStatus } from "@ace/protocol/forge";
import {
  ForgePrDetail,
  ForgePrFiles,
  ForgePrList,
  ForgePrSearch,
  ForgeFilePageInput,
  ForgeCommit,
} from "@ace/protocol/forge-browser";
import { ForgePrCheckout } from "@ace/protocol/forge-worktree";
import type { ForgeReader } from "./api.ts";
import { ForgeError } from "./errors.ts";
import { clipText } from "./host-text.ts";
import { redactData } from "./redact.ts";
import { prUrl } from "./pr-reference.ts";
import { forgeCapabilities } from "./forge-capabilities.ts";
import { BitbucketPulls, type BitbucketOptions } from "./bitbucket-pulls.ts";
import { BitbucketReviews } from "./bitbucket-reviews.ts";
import { bitbucketChecks } from "./bitbucket-checks.ts";
import {
  account,
  decode,
  name,
  page,
  pull,
  ref,
  row,
  sha,
  sourceRepository,
  state,
} from "./bitbucket-records.ts";

const diffstat = z.looseObject({
  status: z.string(),
  lines_added: z.number().int().nonnegative().optional(),
  lines_removed: z.number().int().nonnegative().optional(),
  old: z.looseObject({ path: z.string() }).nullable().optional(),
  new: z.looseObject({ path: z.string() }).nullable().optional(),
});
const commit = z.looseObject({
  hash: sha,
  message: z.string().optional(),
  date: z.string().nullable().optional(),
  author: z.looseObject({ raw: z.string().optional(), user: account.optional() }).optional(),
});
const PullPage = page(pull, 25).extend({ page: z.number().int().positive().optional() });
const FilePage = page(diffstat, 25).extend({ page: z.number().int().positive().optional() });

/** Bitbucket Cloud pull request reads through the user's identity-pinned bkt context. */
export class BitbucketReader implements ForgeReader {
  readonly repository: ForgeRepository;
  readonly reviews: BitbucketReviews;
  readonly #pulls: BitbucketPulls;
  readonly #options: BitbucketOptions;
  constructor(options: BitbucketOptions) {
    this.#pulls = new BitbucketPulls(options);
    this.#options = options;
    this.repository = options.repository;
    this.reviews = new BitbucketReviews(options);
  }
  async status(number: number, signal: AbortSignal) {
    const { p, head } = await this.#pulls.pinned(number, signal);
    const conversation = await this.reviews.conversation(number, signal);
    const checks = await bitbucketChecks(
      this.#options.runner,
      this.#options.login,
      this.#pulls.root,
      number,
      head,
      signal,
    );
    await this.#pulls.still(number, head, signal);
    return decode(ForgePrStatus, {
      ref: ref(this.repository, number),
      title: clipText(p.title),
      url: prUrl({ repository: this.repository, number }),
      headSha: head,
      state: state(p),
      // Conflicts need Bitbucket's mergeability checks, which aren't read: never "mergeable".
      mergeability: "unknown",
      ci: checks.ci,
      checks: checks.checks,
      comments: conversation.comments,
      reviewThreads: conversation.reviewThreads,
      raw: redactData({ ...p, conversation: conversation.raw, checks: checks.raw }),
    });
  }
  async listPrs(input: ForgePrSearch, signal: AbortSignal) {
    const q = ForgePrSearch.parse(input);
    // Searches Bitbucket's list can't express are refused, never answered unfiltered.
    if (
      q.ci !== "any" ||
      q.review !== "any" ||
      q.search ||
      q.author ||
      q.reviewer ||
      q.assignee ||
      q.labels.length ||
      q.sort === "comments"
    )
      throw new ForgeError("unsupported");
    const states =
      q.state === "merged"
        ? ["MERGED"]
        : q.state === "closed"
          ? ["DECLINED", "SUPERSEDED"]
          : q.state === "all"
            ? ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]
            : ["OPEN"];
    const params = new URLSearchParams(states.map((s) => ["state", s]));
    params.set("sort", `${q.order === "desc" ? "-" : ""}${q.sort}_on`);
    params.set("pagelen", "25");
    params.set("page", String(q.page));
    const data = decode(
      PullPage,
      await this.#pulls.get(`${this.#pulls.root}/pullrequests?${params}`, signal),
    );
    if (data.page !== undefined && data.page !== q.page) throw new ForgeError("invalid_data");
    const items = data.values
      .flatMap((p) => row(this.repository, p) ?? [])
      .filter(
        (p) =>
          q.state === "all" ||
          q.state === "active" ||
          (q.state === "open" ? p.state === "open" : p.state === q.state),
      );
    const more = data.next !== undefined;
    return decode(ForgePrList, {
      repository: this.repository,
      items,
      total: data.size ?? items.length,
      ...(more && q.page < 40 ? { nextPage: q.page + 1 } : {}),
      counts: { open: 0, draft: 0, closed: 0, merged: 0 },
      // Bitbucket's size counts drafts with open, and per-state counts aren't read.
      incomplete: true,
      truncated: more && q.page === 40,
    });
  }
  async prDetail(number: number, signal: AbortSignal) {
    const { p, base } = await this.#pulls.pinned(number, signal);
    return decode(ForgePrDetail, {
      status: await this.status(number, signal),
      capabilities: forgeCapabilities.bitbucket,
      readOnly: false,
      body: clipText(p.description ?? ""),
      author: name(p.author),
      ...(p.created_on ? { createdAt: p.created_on } : {}),
      ...(p.updated_on ? { updatedAt: p.updated_on } : {}),
      headBranch: clipText(p.source.branch.name),
      baseBranch: clipText(p.destination.branch.name),
      baseSha: base,
      headRepository: sourceRepository(this.repository, p),
      labels: [],
      reviewers: (await this.reviews.reviewers(number, signal)).reviews.map((r) => r.login),
      // Required approvals are branch restrictions only admins can read: unknown, never null.
      reviewDecision: "UNKNOWN",
      commits: 0,
      changedFiles: 0,
      unavailableResources: ["commits", "fileCount"],
      relatedThreads: [],
      relatedThreadsTruncated: false,
    });
  }
  async prCheckout(number: number, signal: AbortSignal) {
    const { p, head, base } = await this.#pulls.pinned(number, signal);
    const source = sourceRepository(this.repository, p);
    if (!source) throw new ForgeError("unsupported");
    return decode(ForgePrCheckout, {
      ref: ref(this.repository, number),
      headSha: head,
      baseSha: base,
      headBranch: p.source.branch.name,
      baseBranch: p.destination.branch.name,
      headRepository: source,
    });
  }
  async prFiles(
    input: {
      number: number;
      page: number;
      headSha: string;
      baseSha: string;
      commit?: string | undefined;
      since?: string | undefined;
    },
    signal: AbortSignal,
  ) {
    ForgeFilePageInput.parse(input);
    if (input.commit !== undefined || input.since !== undefined)
      throw new ForgeError("unsupported");
    await this.#at(input.number, input.headSha, input.baseSha, signal);
    const data = decode(
      FilePage,
      await this.#pulls.get(
        `${this.#pulls.root}/pullrequests/${input.number}/diffstat?pagelen=25&page=${input.page}`,
        signal,
      ),
    );
    if (data.page !== undefined && data.page !== input.page) throw new ForgeError("invalid_data");
    await this.#at(input.number, input.headSha, input.baseSha, signal);
    const more = data.next !== undefined;
    return decode(ForgePrFiles, {
      ref: ref(this.repository, input.number),
      headSha: input.headSha,
      baseSha: input.baseSha,
      files: data.values.flatMap((f) => {
        const path = f.new?.path ?? f.old?.path;
        if (!path) return [];
        const renamed = f.status === "renamed" && f.old?.path && f.old.path !== path;
        return [
          {
            path: clipText(path),
            ...(renamed ? { previousPath: clipText(f.old?.path ?? "") } : {}),
            status: clipText(f.status),
            additions: f.lines_added ?? 0,
            deletions: f.lines_removed ?? 0,
            // Diffstat has no patch. Never present an absent diff as empty.
            patch: null,
            truncated: true,
            raw: redactData(f),
          },
        ];
      }),
      ...(more && input.page < 40 ? { nextPage: input.page + 1 } : {}),
      truncated: data.values.length > 0 || more,
    });
  }
  async prCommits(
    number: number,
    before: string | undefined,
    headSha: string,
    signal: AbortSignal,
  ) {
    if (before !== undefined && !/^[1-9]\d?$/.test(before)) throw new ForgeError("invalid_data");
    await this.#at(number, headSha, undefined, signal);
    // Bitbucket lists newest first with opaque page links: read them all (at most 1,000), then
    // serve pages of 100, oldest first within a page, newest page first.
    const all = await this.#pulls.all(
      `${this.#pulls.root}/pullrequests/${number}/commits?pagelen=100`,
      commit,
      1000,
      signal,
    );
    if (all[0]?.hash !== headSha.toLowerCase()) throw new ForgeError("head_moved");
    await this.#at(number, headSha, undefined, signal);
    const oldest = all.toReversed();
    const pages = Math.max(1, Math.ceil(oldest.length / 100));
    const index = before === undefined ? pages : Number(before);
    if (index > pages) throw new ForgeError("invalid_data");
    const repo = this.repository;
    return {
      commits: oldest.slice((index - 1) * 100, index * 100).map((c) =>
        decode(ForgeCommit, {
          sha: c.hash,
          message: clipText(c.message ?? ""),
          author: clipText(name(c.author?.user) || (c.author?.raw ?? "")),
          date: c.date ?? null,
          url: `https://${repo.host}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${c.hash}`,
          raw: redactData(c),
        }),
      ),
      ...(index > 1 ? { before: String(index - 1) } : {}),
      total: oldest.length,
      truncated: false,
    };
  }
  /** Refused unless the pull request is still at `head` (and `base`, when given). */
  async #at(number: number, head: string, base: string | undefined, signal: AbortSignal) {
    decode(sha, head.toLowerCase());
    if (base !== undefined) decode(sha, base.toLowerCase());
    const pinned = await this.#pulls.pinned(number, signal);
    if (
      pinned.head !== head.toLowerCase() ||
      (base !== undefined && pinned.base !== base.toLowerCase())
    )
      throw new ForgeError("head_moved");
    return pinned;
  }
}
