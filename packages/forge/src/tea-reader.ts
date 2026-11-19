import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
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
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { teaGet, teaRepoPath } from "./tea-api.ts";
import { decode, pull, ref, status, labels, row, headRepository, sha } from "./tea-records.ts";
import { clipText } from "./host-text.ts";
import { redactData } from "./redact.ts";
import { teaChecks } from "./tea-checks.ts";
import { isTeaHost } from "./tea-hosts.ts";
import { TeaReviews } from "./tea-reviews.ts";
import { TeaIssues } from "./tea-issues.ts";
import { forgeCapabilities } from "./forge-capabilities.ts";

const file = z.looseObject({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
const commit = z.looseObject({
  sha,
  commit: z.looseObject({
    message: z.string(),
    author: z.looseObject({ name: z.string(), date: z.string().nullable().optional() }),
  }),
  author: z.looseObject({ login: z.string() }).nullable().optional(),
});

const PullPage = z.array(pull).max(25);
const FilePage = z.array(file).max(25);
const CommitPage = z.array(commit).max(100);

/** Shared Gitea/Forgejo API v1 reads through the user's identity-pinned tea login. */
export class TeaReader implements ForgeReader {
  readonly repository: ForgeRepository;
  readonly issues: TeaIssues;
  readonly reviews: TeaReviews;
  private runner: CommandRunner;
  private login: string;
  private root: string;
  constructor(options: { repository: ForgeRepository; runner: CommandRunner; login: string }) {
    this.repository = options.repository;
    if (!isTeaHost(options.repository.forge)) throw new ForgeError("unsupported");
    this.runner = options.runner;
    this.login = options.login;
    this.root = teaRepoPath(options.repository);
    this.issues = new TeaIssues(options);
    this.reviews = new TeaReviews(options);
  }
  private get(path: string, signal: AbortSignal) {
    return teaGet(this.runner, this.login, `${this.root}/${path}`, signal);
  }
  private async pull(number: number, signal: AbortSignal) {
    ref(this.repository, number);
    const p = decode(pull, (await this.get(`pulls/${number}`, signal)).body);
    if (p.number !== number) throw new ForgeError("invalid_data");
    return p;
  }
  private async pinned(
    number: number,
    headSha: string,
    baseSha: string | undefined,
    signal: AbortSignal,
  ) {
    decode(sha, headSha);
    if (baseSha !== undefined) decode(sha, baseSha);
    const p = await this.pull(number, signal);
    if (p.head.sha !== headSha || (baseSha !== undefined && p.base.sha !== baseSha))
      throw new ForgeError("head_moved");
    return p;
  }
  async status(number: number, signal: AbortSignal) {
    const p = await this.pull(number, signal);
    const conversation = await this.reviews.conversation(number, signal);
    const checks = await teaChecks(this.runner, this.login, this.root, p.head.sha, signal);
    const latest = await this.pull(number, signal);
    if (latest.head.sha !== p.head.sha) throw new ForgeError("head_moved");
    return {
      ...status(this.repository, p),
      ...conversation,
      ...checks,
      raw: redactData({ ...p, conversation: conversation.raw, checks: checks.raw }),
    };
  }
  async listPrs(input: ForgePrSearch, signal: AbortSignal) {
    const q = ForgePrSearch.parse(input);
    // Gitea's PR list does not implement these searches. Never silently return unfiltered rows.
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
    const params = new URLSearchParams({
      state: ["closed", "merged"].includes(q.state) ? "closed" : q.state === "all" ? "all" : "open",
      sort:
        q.sort === "created"
          ? q.order === "desc"
            ? "newest"
            : "oldest"
          : q.order === "desc"
            ? "recentupdate"
            : "leastupdate",
      page: String(q.page),
      limit: "25",
    });
    const response = await this.get(`pulls?${params}`, signal);
    const data = decode(PullPage, response.body);
    const rows = data.flatMap((p) => row(this.repository, p) ?? []);
    const items = rows.filter(
      (p) =>
        q.state === "all" ||
        (q.state === "active" ? p.state === "open" || p.state === "draft" : p.state === q.state),
    );
    const more = response.total === undefined ? data.length === 25 : q.page * 25 < response.total;
    return decode(ForgePrList, {
      repository: this.repository,
      items,
      total: response.total ?? items.length,
      ...(more && q.page < 40 ? { nextPage: q.page + 1 } : {}),
      counts: { open: 0, draft: 0, closed: 0, merged: 0 },
      // Host totals include drafts or merged rows filtered locally; counts are not known.
      incomplete: true,
      truncated: more && q.page === 40,
    });
  }
  async prDetail(number: number, signal: AbortSignal) {
    const p = await this.pull(number, signal);
    return decode(ForgePrDetail, {
      status: await this.status(number, signal),
      capabilities: forgeCapabilities[this.repository.forge],
      readOnly: false,
      body: clipText(p.body ?? ""),
      author: clipText(p.user?.login ?? ""),
      headBranch: clipText(p.head.ref),
      baseBranch: clipText(p.base.ref),
      baseSha: p.base.sha,
      headRepository: headRepository(this.repository, p),
      labels: labels(p),
      reviewers: (await this.reviews.reviewers(number, signal)).reviews.map((r) => r.login),
      // Gitea's required approvals aren't read: unknown, never "no review required" (null).
      reviewDecision: "UNKNOWN",
      commits: 0,
      changedFiles: p.changed_files ?? 0,
      unavailableResources: ["commits", ...(p.changed_files === undefined ? ["fileCount"] : [])],
      relatedThreads: [],
      relatedThreadsTruncated: false,
    });
  }
  async prCheckout(number: number, signal: AbortSignal) {
    const p = await this.pull(number, signal);
    const head = headRepository(this.repository, p);
    if (!head) throw new ForgeError("unsupported");
    return decode(ForgePrCheckout, {
      ref: ref(this.repository, number),
      headSha: p.head.sha,
      baseSha: p.base.sha,
      headBranch: p.head.ref,
      baseBranch: p.base.ref,
      headRepository: head,
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
    await this.pinned(input.number, input.headSha, input.baseSha, signal);
    const response = await this.get(
      `pulls/${input.number}/files?page=${input.page}&limit=25`,
      signal,
    );
    const data = decode(FilePage, response.body);
    await this.pinned(input.number, input.headSha, input.baseSha, signal);
    const more =
      response.total === undefined ? data.length === 25 : input.page * 25 < response.total;
    return decode(ForgePrFiles, {
      ref: ref(this.repository, input.number),
      headSha: input.headSha,
      baseSha: input.baseSha,
      files: data.map((f) => ({
        path: clipText(f.filename),
        ...(f.previous_filename ? { previousPath: clipText(f.previous_filename) } : {}),
        status: clipText(f.status),
        additions: f.additions,
        deletions: f.deletions,
        // API v1 ChangedFile has no patch. Never present an absent diff as empty.
        patch: null,
        truncated: true,
        raw: redactData(f),
      })),
      ...(more && input.page < 40 ? { nextPage: input.page + 1 } : {}),
      truncated: data.length > 0 || more,
    });
  }
  async prCommits(
    number: number,
    before: string | undefined,
    headSha: string,
    signal: AbortSignal,
  ) {
    // The API returns oldest first. A bounded full traversal yields newest pages first.
    if (before !== undefined && !/^[1-9]\d?$/.test(before)) throw new ForgeError("invalid_data");
    const p = await this.pinned(number, headSha, undefined, signal);
    const first = await this.get(
      `pulls/${number}/commits?page=1&limit=100&verification=false&files=false`,
      signal,
    );
    const total = first.total;
    if (total === undefined || total > 1000) throw new ForgeError("limit");
    const pages = Math.max(1, Math.ceil(total / 100));
    const page = before === undefined ? pages : Number(before);
    if (page > pages) throw new ForgeError("invalid_data");
    const response =
      page === 1
        ? first
        : await this.get(
            `pulls/${number}/commits?page=${page}&limit=100&verification=false&files=false`,
            signal,
          );
    const data = decode(CommitPage, response.body);
    await this.pinned(number, headSha, p.base.sha, signal);
    return {
      commits: data.toReversed().map((c) =>
        decode(ForgeCommit, {
          sha: c.sha,
          message: clipText(c.commit.message),
          author: clipText(c.author?.login ?? c.commit.author.name),
          date: c.commit.author.date ?? null,
          url: `https://${this.repository.host}/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.name)}/commit/${c.sha}`,
          raw: redactData(c),
        }),
      ),
      ...(page > 1 ? { before: String(page - 1) } : {}),
      total,
      truncated: false,
    };
  }
}
