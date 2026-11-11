import type { ForgeRepository } from "@ace/protocol/forge";
import { z } from "zod";
import { ForgeMergeCommit, ForgeMergeState } from "@ace/protocol/forge-merge-state";
import type { MergeMethod } from "./api.ts";
import { GitLabApi, gitLabProjectPath } from "./gitlab-api.ts";
import { GitLabChecks } from "./gitlab-checks.ts";
import { gitLabCi } from "./gitlab-check-records.ts";
import { ReadBudget } from "./read-budget.ts";
import { writesUnder, type HostApiWrite } from "./read-only-api.ts";
import { ForgeError } from "./errors.ts";
import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";
import { mergeStateChangeObserved } from "./merge-state.ts";

export type GitLabMergeApi = GitLabApi;

/** Only these two documented writes belong to merge and auto-merge, in `repository` only. */
export function gitlabMergeWrites(repository: ForgeRepository): readonly HostApiWrite[] {
  return writesUnder(gitLabProjectPath(repository), [
    { method: "PUT", path: "/merge_requests/[1-9]\\d*/merge" },
    { method: "POST", path: "/merge_requests/[1-9]\\d*/cancel_merge_when_pipeline_succeeds" },
  ]);
}
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const text = z.string().max(65_536);
const source = z.looseObject({
  iid: z.number().int().positive(),
  sha,
  state: text,
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  detailed_merge_status: text.optional(),
  has_conflicts: z.boolean().optional(),
  blocking_discussions_resolved: z.boolean().optional(),
  merge_when_pipeline_succeeds: z.boolean(),
  squash: z.boolean(),
  user: z.looseObject({ can_merge: z.boolean() }).optional(),
  merge_user: z.looseObject({ username: text }).nullable().optional(),
  head_pipeline: z
    .looseObject({ id: z.number().int().positive(), status: text, sha })
    .nullable()
    .optional(),
});
const project = z.looseObject({
  squash_option: z.enum(["never", "always", "default_on", "default_off"]),
  /** "Pipelines must succeed" (docs.gitlab.com/api/projects/); absent when not readable. */
  only_allow_merge_if_pipeline_succeeds: z.boolean().optional(),
});

/** Detailed merge status is GitLab's authoritative aggregation of approval and branch rules.
 * Missing, computing and future statuses never become a clean merge. Raw fields survive.
 * `requiresPipeline` is the project's "pipelines must succeed": an MR with no pipeline merges
 * only where it is known to be false. */
export function gitlabMergeState(raw: unknown, requiresPipeline?: boolean): ForgeMergeState {
  const decoded = source.safeParse(raw);
  if (!decoded.success) throw new ForgeError("invalid_data");
  const mr = decoded.data;
  const status = mr.detailed_merge_status ?? "unknown";
  const blockers: string[] = [];
  const draft = mr.draft ?? mr.work_in_progress;
  if (draft !== false)
    blockers.push(draft ? "This merge request is a draft." : "Draft status is unknown.");
  if (mr.state !== "opened") blockers.push(`Merge request state: ${mr.state}.`);
  if (status !== "mergeable") blockers.push(`GitLab merge rules: ${status}.`);
  if (mr.has_conflicts) blockers.push("The source branch has conflicts.");
  if (mr.blocking_discussions_resolved === false) blockers.push("Discussions must be resolved.");
  const pipeline = mr.head_pipeline;
  if (!pipeline && requiresPipeline !== false)
    blockers.push(
      requiresPipeline
        ? "A pipeline must succeed, and none has run."
        : "Whether a pipeline must succeed is unknown.",
    );
  if (pipeline && (pipeline.sha !== mr.sha || pipeline.status !== "success"))
    blockers.push(
      pipeline.sha !== mr.sha ? "Pipeline belongs to another head." : `Checks: ${pipeline.status}.`,
    );
  return ForgeMergeState.parse({
    headSha: mr.sha,
    state: mr.state === "opened" ? (draft === true ? "DRAFT" : "OPEN") : mr.state.toUpperCase(),
    mergeState:
      mr.has_conflicts === true || status === "conflict"
        ? "DIRTY"
        : // The source branch must be rebased onto the target first: GitHub's BEHIND.
          status === "need_rebase"
          ? "BEHIND"
          : status === "mergeable" && blockers.length === 0
            ? "CLEAN"
            : ["unknown", "checking", "unchecked", "preparing", "approvals_syncing"].includes(
                  status,
                )
              ? "UNKNOWN"
              : "BLOCKED",
    reviewDecision: status === "not_approved" ? "REVIEW_REQUIRED" : null,
    checksState: pipeline
      ? pipeline.sha === mr.sha
        ? gitLabCi(pipeline.status).toUpperCase()
        : "UNKNOWN"
      : requiresPipeline === false
        ? "NONE"
        : "UNKNOWN",
    // GitLab exposes no enable timestamp. Do not invent one from updated_at.
    autoMerge: mr.merge_when_pipeline_succeeds
      ? {
          method: mr.squash ? "SQUASH" : "MERGE",
          actor: mr.merge_user?.username ?? null,
          enabledAt: "",
        }
      : null,
    queue: null,
    canEnable: mr.state === "opened" && draft === false && mr.user?.can_merge === true,
    canDisable:
      mr.state === "opened" && mr.merge_when_pipeline_succeeds && mr.user?.can_merge === true,
    canDequeue: false,
    blockers,
    raw,
  });
}

const Version = z.looseObject({ version: z.string() });
const CancelAck = z.looseObject({ status: z.literal("success") });

/** Pinned-head merge operations. The durable write fence belongs to WorkspaceForgeActions. */
export class GitLabMergeState {
  readonly #api: GitLabMergeApi;
  readonly #root: string;
  readonly #checks: GitLabChecks;
  constructor(api: GitLabMergeApi) {
    this.#api = api;
    this.#checks = new GitLabChecks(api);
    this.#root = api.root;
  }
  #path(number: number) {
    z.number().int().positive().parse(number);
    return `${this.#root}/merge_requests/${number}`;
  }
  async read(number: number, signal: AbortSignal): Promise<ForgeMergeState> {
    const budget = new ReadBudget();
    const page = await this.#api.get(this.#path(number), signal, budget);
    const settings = await this.#project(signal, budget);
    const state = gitlabMergeState(page.body, settings.requiresPipeline);
    if (source.parse(page.body).iid !== number) throw new ForgeError("invalid_data");
    const pipeline = source.parse(page.body).head_pipeline;
    if (pipeline) {
      const snapshot = await this.#checks.snapshot(number, state.headSha, signal, budget);
      const checksState =
        snapshot.pipelineId !== pipeline.id || pipeline.sha !== state.headSha
          ? "UNKNOWN"
          : snapshot.ci === "none"
            ? "UNKNOWN"
            : snapshot.ci.toUpperCase();
      if (checksState !== "SUCCESS") {
        state.checksState = checksState;
        if (state.mergeState !== "DIRTY")
          state.mergeState = checksState === "UNKNOWN" ? "UNKNOWN" : "BLOCKED";
        state.blockers.push(`Head pipeline jobs: ${checksState}.`);
      }
    }
    return { ...state, methods: settings.methods };
  }
  async #methods(signal: AbortSignal, budget = new ReadBudget()): Promise<MergeMethod[]> {
    return (await this.#project(signal, budget)).methods;
  }
  /** The project's merge methods and whether its MRs need a passing pipeline. */
  async #project(signal: AbortSignal, budget: ReadBudget) {
    const parsed = project.safeParse((await this.#api.get(this.#root, signal, budget)).body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    const methods: MergeMethod[] =
      parsed.data.squash_option === "always"
        ? ["squash"]
        : parsed.data.squash_option === "never"
          ? ["merge"]
          : ["merge", "squash"];
    return { methods, requiresPipeline: parsed.data.only_allow_merge_if_pipeline_succeeds };
  }
  async #preflight(number: number, headSha: string, method: MergeMethod, signal: AbortSignal) {
    sha.parse(headSha);
    z.enum(["merge", "squash", "rebase"]).parse(method);
    if (method === "rebase") throw new ForgeError("unsupported", undefined, false);
    const state = await this.read(number, signal);
    if (state.headSha !== headSha) throw new ForgeError("head_moved", undefined, false);
    return state;
  }
  async #autoFields(signal: AbortSignal): Promise<Record<string, boolean>> {
    // Older servers can ignore an unknown auto_merge parameter, so choose only from a proven version.
    const response = await this.#api.get("version", signal, new ReadBudget());
    const version = Version.safeParse(response.body);
    const parts = version.success ? /^(\d+)\.(\d+)(?:\.|-)/.exec(version.data.version) : null;
    if (!parts) throw new ForgeError("unsupported", undefined, false);
    const major = Number(parts[1]),
      minor = Number(parts[2]);
    if (major > 17 || (major === 17 && minor >= 11)) return { auto_merge: true };
    if (major >= 12) return { merge_when_pipeline_succeeds: true };
    throw new ForgeError("unsupported", undefined, false);
  }
  async #accept(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
    dispatch: MutationDispatch,
    intent: "merge" | "autoMerge",
    commit?: ForgeMergeCommit,
  ): Promise<void> {
    if (!(await this.#methods(signal)).includes(method))
      throw new ForgeError("conflict", undefined, false);
    const message = commit ? ForgeMergeCommit.parse(commit) : undefined;
    const result = await this.#api.write(
      `${this.#path(number)}/merge`,
      "PUT",
      {
        sha: headSha,
        squash: method === "squash",
        ...(intent === "autoMerge" ? await this.#autoFields(signal) : { auto_merge: false }),
        ...(message
          ? {
              [method === "squash" ? "squash_commit_message" : "merge_commit_message"]:
                `${message.title}${message.message ? `\n\n${message.message}` : ""}`,
            }
          : {}),
      },
      signal,
      new ReadBudget(),
      dispatch,
      () => ({ number, headSha }),
    );
    const ack = source.safeParse(result.body);
    if (
      !ack.success ||
      ack.data.iid !== number ||
      ack.data.sha !== headSha ||
      !(
        ack.data.state === "merged" ||
        (intent === "autoMerge" &&
          ack.data.merge_when_pipeline_succeeds &&
          ack.data.squash === (method === "squash"))
      )
    )
      throw new ForgeMutationOutcome({ number, headSha });
  }
  async merge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
    dispatch = new MutationDispatch(),
    commit?: ForgeMergeCommit,
  ): Promise<void> {
    const state = await this.#preflight(number, headSha, method, signal);
    if (state.state === "MERGED") return;
    if (state.blockers.length) throw new ForgeError("conflict", undefined, false);
    if (!state.canEnable) throw new ForgeError("forbidden", undefined, false);
    await this.#accept(number, headSha, method, signal, dispatch, "merge", commit);
  }
  async change(
    number: number,
    headSha: string,
    action: "enable" | "disable" | "dequeue",
    method: MergeMethod,
    signal: AbortSignal,
    allowed: () => boolean = () => true,
    dispatch = new MutationDispatch(),
    commit?: ForgeMergeCommit,
  ): Promise<ForgeMergeState | undefined> {
    z.enum(["enable", "disable", "dequeue"]).parse(action);
    if (action === "dequeue") throw new ForgeError("unsupported", undefined, false);
    const state = await this.#preflight(number, headSha, method, signal);
    if (!allowed()) throw new ForgeError("forbidden", undefined, false);
    if (mergeStateChangeObserved(state, headSha, action, method)) return state;
    if (!(action === "enable" ? state.canEnable : state.canDisable))
      throw new ForgeError("forbidden", undefined, false);
    if (action === "enable")
      await this.#accept(number, headSha, method, signal, dispatch, "autoMerge", commit);
    else {
      // GitLab's cancellation has no sha parameter. Preflight pins the observed head; the host
      // enforces permissions. Use the older documented endpoint for deployed GitLab versions.
      const result = await this.#api.write(
        `${this.#path(number)}/cancel_merge_when_pipeline_succeeds`,
        "POST",
        {},
        signal,
        new ReadBudget(),
        dispatch,
        () => ({ number, headSha }),
      );
      const ack = CancelAck.safeParse(result.body);
      if (!ack.success) throw new ForgeMutationOutcome({ number, headSha });
    }
    // Persist acknowledgement in the shell before any lagging follow-up read.
    return undefined;
  }
}
