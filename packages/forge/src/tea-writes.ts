import { z } from "zod";
import { ForgeMergeState, type ForgeMergeCommit } from "@ace/protocol/forge-merge-state";
import type { MergeMethod } from "./api.ts";
import { WriteDispatch } from "./write-dispatch.ts";
import { TeaReader } from "./tea-reader.ts";
import { decode, pull, sha } from "./tea-records.ts";
import { teaChecks } from "./tea-checks.ts";
import { teaGet, teaResponse } from "./tea-api.ts";
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
  private async write(path: string, body: object, signal: AbortSignal, dispatch: WriteDispatch) {
    const result = await this.options.runner({
      command: "tea",
      args: [
        "api",
        `${this.root}${path}`,
        "--method",
        "POST",
        "--login",
        this.options.login,
        "--include",
        "--data",
        "@-",
      ],
      input: JSON.stringify(body),
      mode: "json",
      signal,
      dispatch,
    });
    if (result.identityChanged) throw new ForgeError("outcome_uncertain");
    return teaResponse(
      path.endsWith("/merge") && result.http?.status === 200 && !result.stdout.trim()
        ? { ...result, stdout: "null" }
        : result,
    );
  }
  async prMergeState(number: number, signal: AbortSignal) {
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
    const methods: MergeMethod[] = [];
    if (repo.allow_merge_commits) methods.push("merge");
    if (repo.allow_squash_merge) methods.push("squash");
    if (repo.allow_rebase) methods.push("rebase");
    return decode(ForgeMergeState, {
      headSha: p.head.sha,
      state: p.merged ? "MERGED" : p.state.toUpperCase(),
      mergeState: p.mergeable === true ? "CLEAN" : "UNKNOWN",
      reviewDecision: null,
      checksState: checks.ci.toUpperCase(),
      autoMerge: null,
      queue: null,
      methods: repo.permissions.push && !repo.archived ? methods : [],
      canEnable: false,
      canDisable: false,
      canDequeue: false,
      blockers: [],
      raw: {},
    });
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
    const state = await this.prMergeState(number, signal);
    if (state.headSha !== headSha) throw new ForgeError("head_moved");
    if (state.state !== "OPEN" || state.mergeState !== "CLEAN" || !state.methods?.includes(method))
      throw new ForgeError("forbidden");
    if (state.checksState !== "SUCCESS" && state.checksState !== "NONE")
      throw new ForgeError("forbidden");
    if (method === "rebase" && commit) throw new ForgeError("unsupported");
    await this.write(
      `/pulls/${number}/merge`,
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
