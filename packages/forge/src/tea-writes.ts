import { z } from "zod";
import { ForgeMergeState, type ForgeMergeCommit } from "@ace/protocol/forge-merge-state";
import type { MergeMethod } from "./api.ts";
import { WriteDispatch } from "./write-dispatch.ts";
import { TeaReader } from "./tea-reader.ts";
import { decode, pull, sha, state as pullState, type Pull } from "./tea-records.ts";
import { teaChecks } from "./tea-checks.ts";
import { teaGet, teaWrite } from "./tea-api.ts";
import { ForgeError } from "./errors.ts";
import type { HostApiWrite } from "./read-only-api.ts";

/** Only head-pinned merges; conversation writes belong to TeaReviews. */
export const teaWrites: readonly HostApiWrite[] = [
  { method: "POST", endpoint: /^repos\/[^/?]+\/[^/?]+\/pulls\/\d+\/merge$/ },
];
const metadata = z.object({
  archived: z.boolean().default(true),
  permissions: z.object({ push: z.boolean() }),
  allow_merge_commits: z.boolean(),
  allow_squash_merge: z.boolean(),
  allow_rebase: z.boolean(),
});

export class TeaWriter {
  readonly reader: TeaReader;
  private options: ConstructorParameters<typeof TeaReader>[0];
  private root: string;
  constructor(options: ConstructorParameters<typeof TeaReader>[0]) {
    this.options = options;
    this.reader = new TeaReader(options);
    this.root = `repos/${encodeURIComponent(options.repository.owner)}/${encodeURIComponent(options.repository.name)}`;
  }
  status(number: number, signal: AbortSignal) {
    return this.reader.status(number, signal);
  }
  async currentUser(): Promise<never> {
    throw new ForgeError("unsupported");
  }
  async replyComment(): Promise<never> {
    throw new ForgeError("unsupported");
  }
  async requestReviews(): Promise<never> {
    throw new ForgeError("unsupported");
  }
  async changeMergeState(): Promise<never> {
    throw new ForgeError("unsupported");
  }
  private get(path: string, signal: AbortSignal) {
    return teaGet(this.options.runner, this.options.login, `${this.root}${path}`, signal);
  }
  async #read(number: number, signal: AbortSignal) {
    const p = decode(pull, (await this.get(`/pulls/${number}`, signal)).body);
    if (p.number !== number) throw new ForgeError("invalid_data");
    const repo = decode(metadata, (await this.get("", signal)).body);
    const checks = await teaChecks(
      this.options.runner,
      this.options.login,
      this.root,
      p.head.sha,
      signal,
    );
    return { p, repo, checks };
  }
  async prMergeState(number: number, signal: AbortSignal) {
    const { p, repo, checks } = await this.#read(number, signal);
    return teaMergeState(p, repo, checks.ci);
  }
  async merge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
    dispatch = new WriteDispatch(),
    commit?: ForgeMergeCommit,
  ) {
    decode(sha, headSha);
    const { p, repo, checks } = await this.#read(number, signal);
    const state = teaMergeState(p, repo, checks.ci);
    if (state.headSha !== headSha) throw new ForgeError("head_moved");
    // A draft, a PR Gitea hasn't found free of conflicts, or failing or unsettled checks never
    // reach the host. Branch protection and approvals stay the host's to enforce.
    if (pullState(p) !== "open" || p.mergeable !== true || !state.methods?.includes(method))
      throw new ForgeError("forbidden");
    if (checks.ci !== "success" && checks.ci !== "none") throw new ForgeError("forbidden");
    if (method === "rebase" && commit) throw new ForgeError("unsupported");
    await teaWrite(
      this.options.runner,
      this.options.login,
      `${this.root}/pulls/${number}/merge`,
      "POST",
      {
        do: method,
        head_commit_id: headSha,
        force_merge: false,
        merge_when_checks_succeed: false,
        delete_branch_after_merge: false,
        ...(commit ? { merge_title_field: commit.title, merge_message_field: commit.message } : {}),
      },
      signal,
      dispatch,
    );
  }
}

/**
 * A pull request's merge state. Drafts read as `DRAFT`, from the same draft rule as every
 * Gitea read. Gitea's `mergeable` only says there are no conflicts; branch protection and
 * required approvals aren't read, so even a conflict-free PR is `UNKNOWN`, never `CLEAN`, and
 * its review decision is `UNKNOWN`, never null ("no review required").
 */
export function teaMergeState(
  p: Pull,
  repo: z.infer<typeof metadata>,
  ci: "none" | "pending" | "success" | "failure" | "unknown",
) {
  const state = pullState(p);
  const methods: MergeMethod[] = [];
  if (repo.allow_merge_commits) methods.push("merge");
  if (repo.allow_squash_merge) methods.push("squash");
  if (repo.allow_rebase) methods.push("rebase");
  const blockers: string[] = [];
  if (state === "draft") blockers.push("This pull request is a draft.");
  return decode(ForgeMergeState, {
    headSha: p.head.sha,
    state: state === "unknown" ? p.state.toUpperCase() : state.toUpperCase(),
    mergeState: state === "draft" ? "DRAFT" : "UNKNOWN",
    reviewDecision: "UNKNOWN",
    checksState: ci.toUpperCase(),
    autoMerge: null,
    queue: null,
    methods: repo.permissions.push && !repo.archived ? methods : [],
    canEnable: false,
    canDisable: false,
    canDequeue: false,
    blockers,
    raw: {},
  });
}
