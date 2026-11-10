import { clipText } from "./host-text.ts";
import { redactData } from "./redact.ts";
import { z } from "zod";
import { ForgePrRef, type ForgeRepository } from "@ace/protocol/forge";
import { ForgeCommit } from "@ace/protocol/forge-browser";
import { ForgePrReviewers } from "@ace/protocol/forge-people";
import { ForgeError } from "./errors.ts";
import { ReadBudget } from "./read-budget.ts";
import { Mr, headOf, requireSha, must, type GitLabMr } from "./gitlab-records.ts";
import type { GitLabApi } from "./gitlab-api.ts";
import {
  GitLabDiscussion,
  GitLabApprovals,
  GitLabApprovalState,
  GitLabCommits,
  GitLabUsers,
  conversation,
  approvalDecision,
} from "./gitlab-conversation-records.ts";

/** MR conversation reads share the caller's response budget and pinned head. */
export class GitLabConversation {
  readonly api: GitLabApi;
  readonly repository: ForgeRepository;
  readonly root: string;
  constructor(api: GitLabApi, repository: ForgeRepository) {
    this.api = api;
    this.repository = repository;
    this.root = `projects/${encodeURIComponent(`${repository.owner}/${repository.name}`)}/merge_requests`;
  }
  path(number: number) {
    ForgePrRef.parse({ repository: this.repository, number });
    return `${this.root}/${number}`;
  }
  async mr(number: number, signal: AbortSignal, budget = new ReadBudget()) {
    const mr = must(Mr.safeParse((await this.api.get(this.path(number), signal, budget)).body));
    if (mr.iid !== number) throw new ForgeError("invalid_data");
    return mr;
  }
  discussions(number: number, signal: AbortSignal, budget = new ReadBudget()) {
    return this.api.records(`${this.path(number)}/discussions`, GitLabDiscussion, signal, budget);
  }
  async snapshot(number: number, head: string, signal: AbortSignal, budget: ReadBudget) {
    const discussions = await this.discussions(number, signal, budget);
    const approvals = must(
      GitLabApprovals.safeParse(
        (await this.api.get(`${this.path(number)}/approvals`, signal, budget)).body,
      ),
    );
    let state;
    try {
      state = must(
        GitLabApprovalState.safeParse(
          (await this.api.get(`${this.path(number)}/approval_state`, signal, budget)).body,
        ),
      );
    } catch (error) {
      if (
        !(error instanceof ForgeError) ||
        !["not_found", "forbidden", "unsupported"].includes(error.kind)
      )
        throw error;
    }
    if (
      requireSha(headOf(await this.mr(number, signal, budget))).toLowerCase() !== head.toLowerCase()
    )
      throw new ForgeError("head_moved");
    return {
      ...conversation(discussions, head),
      approvals,
      reviewDecision: approvalDecision(approvals, state),
    };
  }
  async reviewers(number: number, signal: AbortSignal, budget = new ReadBudget()) {
    const mr = await this.mr(number, signal, budget);
    const approvals = must(
      GitLabApprovals.safeParse(
        (await this.api.get(`${this.path(number)}/approvals`, signal, budget)).body,
      ),
    );
    return reviewersOf(mr, approvals);
  }
  async commits(
    number: number,
    before: string | undefined,
    head: string,
    signal: AbortSignal,
    budget = new ReadBudget(),
  ) {
    const page = before === undefined ? 1 : Number(before);
    if (!Number.isInteger(page) || page < 1 || page > 20) throw new ForgeError("invalid_data");
    const pin = async () => {
      if (
        requireSha(headOf(await this.mr(number, signal, budget))).toLowerCase() !==
        head.toLowerCase()
      )
        throw new ForgeError("head_moved");
    };
    await pin();
    const { body, headers } = await this.api.get(
      `${this.path(number)}/commits?per_page=100&page=${page}`,
      signal,
      budget,
    );
    const rows = must(GitLabCommits.safeParse(body));
    await pin();
    const next = headers["x-next-page"];
    const more = next !== undefined ? next !== "" : rows.length === 100;
    if (more && next !== undefined && next !== String(page + 1))
      throw new ForgeError("invalid_data");
    const total = headers["x-total"]?.trim() ? Number(headers["x-total"]) : Number.NaN;
    return {
      commits: rows.map((c) =>
        must(
          ForgeCommit.safeParse({
            sha: c.id,
            message: clipText(c.message),
            author: clipText(c.author_name),
            date: c.authored_date === null ? null : clipText(c.authored_date),
            url: clipText(c.web_url),
            raw: redactData(c),
          }),
        ),
      ),
      ...(more && page < 20 ? { before: String(page + 1) } : {}),
      ...(Number.isInteger(total) && total >= 0 ? { total } : {}),
      truncated: more && page === 20,
    };
  }
}

/** Requested reviewers who haven't approved yet, beside the approvals themselves. */
export function reviewersOf(mr: GitLabMr, approvals: z.infer<typeof GitLabApprovals>) {
  const users = must(GitLabUsers.safeParse(mr.reviewers ?? []));
  return must(
    ForgePrReviewers.safeParse({
      requested: users
        .filter((u) => !approvals.approved_by.some((a) => a.user.id === u.id))
        .map((u) =>
          Object.assign(
            { kind: "user", login: u.username },
            u.avatar_url ? { avatarUrl: u.avatar_url } : {},
          ),
        ),
      reviews: approvals.approved_by.map((a) =>
        Object.assign(
          {
            id: a.user.id,
            login: a.user.username,
            state: "APPROVED",
            submittedAt: a.approved_at ?? null,
          },
          a.user.avatar_url ? { avatarUrl: a.user.avatar_url } : {},
        ),
      ),
      suggested: [],
      author: mr.author?.username ?? null,
      canRequest: true,
      canDismiss: false,
    }),
  );
}
