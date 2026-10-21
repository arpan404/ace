import { WriteDispatch } from "./write-dispatch.ts";
import { z } from "zod";
import { ForgeMergeState } from "@ace/protocol/forge-merge-state";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { GhApi, Page } from "./http.ts";
import { ForgeMutationOutcome } from "./mutation.ts";
import { ForgeError, ForgeQueryRefused } from "./errors.ts";
import { mergeStateChangeObserved } from "./merge-state.ts";
import type { MergeMethod } from "./api.ts";

const text = z.string().max(65_536);
const actor = z.looseObject({ login: text });
// The branch rules and deployments only explain a merge state, so a value that doesn't decode
// drops that detail instead of the read.
const baseRef = z
  .looseObject({
    branchProtectionRule: z
      .looseObject({
        requiredApprovingReviewCount: z.number().int().positive().nullish().catch(null),
        requiresConversationResolution: z.boolean().nullish().catch(null),
        requiresCommitSignatures: z.boolean().nullish().catch(null),
        requiresLinearHistory: z.boolean().nullish().catch(null),
      })
      .nullish()
      .catch(null),
    rules: z
      .looseObject({ nodes: z.array(z.looseObject({ type: text }).nullable().catch(null)) })
      .nullish()
      .catch(null),
  })
  .nullish()
  .catch(null);
const deployment = z.looseObject({
  environment: text,
  state: text.nullish(),
  latestStatus: z.looseObject({ state: text, environmentUrl: text.nullish() }).nullish(),
});
const commits = z
  .looseObject({
    nodes: z.array(
      z
        .looseObject({
          commit: z.looseObject({
            deployments: z.looseObject({
              nodes: z.array(deployment.nullable().catch(null)),
            }),
          }),
        })
        .nullable()
        .catch(null),
    ),
  })
  .nullish()
  .catch(null);
const source = z.looseObject({
  id: text,
  number: z.number().int().positive(),
  headRefOid: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  state: text,
  isDraft: z.boolean(),
  mergeStateStatus: text,
  reviewDecision: text.nullable(),
  statusCheckRollup: z.looseObject({ state: text }).nullable(),
  autoMergeRequest: z
    .looseObject({ mergeMethod: text, enabledAt: text, enabledBy: actor.nullable() })
    .nullable(),
  mergeQueueEntry: z
    .looseObject({
      id: text,
      state: text,
      position: z.number().int().nonnegative(),
      enqueuedAt: text,
      estimatedTimeToMerge: z.number().int().nonnegative().nullish().catch(null),
    })
    .nullable(),
  baseRef,
  commits,
  viewerCanEnableAutoMerge: z.boolean(),
  viewerCanDisableAutoMerge: z.boolean(),
});
const responseSchema = z.looseObject({
  data: z.looseObject({
    repository: z
      .looseObject({ viewerPermission: text.nullable(), pullRequest: source.nullable() })
      .nullable(),
  }),
});
const fields = `id number headRefOid state isDraft mergeStateStatus reviewDecision statusCheckRollup{state} autoMergeRequest{mergeMethod enabledAt enabledBy{login}} viewerCanEnableAutoMerge viewerCanDisableAutoMerge`;
const wrap = (selection: string) =>
  `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){viewerPermission pullRequest(number:$number){${selection}}}}`;
const baseQuery = wrap(`${fields} mergeQueueEntry{id state position enqueuedAt}`);
const query = wrap(
  `${fields} mergeQueueEntry{id state position enqueuedAt estimatedTimeToMerge} baseRef{branchProtectionRule{requiredApprovingReviewCount requiresConversationResolution requiresCommitSignatures requiresLinearHistory} rules(first:20){nodes{type}}} commits(last:1){nodes{commit{deployments(last:10){nodes{environment state latestStatus{state environmentUrl}}}}}}`,
);

type Source = z.infer<typeof source>;

/** The outstanding review requirement, with the count when branch protection names one. */
function reviewsRequired(pr: Source): string | undefined {
  if (pr.reviewDecision !== "REVIEW_REQUIRED") return undefined;
  const count = pr.baseRef?.branchProtectionRule?.requiredApprovingReviewCount;
  return count
    ? `${count} approving review${count === 1 ? "" : "s"} required.`
    : "Required reviews are outstanding.";
}

/** What GitHub's branch protection and rulesets require of a BLOCKED pull request. */
function branchRules(pr: Source): string[] {
  if (pr.mergeStateStatus !== "BLOCKED") return [];
  const rule = pr.baseRef?.branchProtectionRule;
  const types = new Set((pr.baseRef?.rules?.nodes ?? []).map((node) => node?.type));
  const rules: string[] = [];
  const reviews = reviewsRequired(pr);
  if (reviews && rule?.requiredApprovingReviewCount) rules.push(reviews);
  if (rule?.requiresConversationResolution || types.has("REQUIRED_REVIEW_THREAD_RESOLUTION"))
    rules.push("Conversations must be resolved.");
  if (rule?.requiresCommitSignatures || types.has("REQUIRED_SIGNATURES"))
    rules.push("Signed commits required.");
  if (rule?.requiresLinearHistory || types.has("REQUIRED_LINEAR_HISTORY"))
    rules.push("Linear history required.");
  const explained =
    rules.length > 0 ||
    reviews !== undefined ||
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    (pr.statusCheckRollup !== null && pr.statusCheckRollup.state !== "SUCCESS");
  if (!explained) rules.push("GitHub's branch rules block this merge.");
  return rules;
}

/** Each environment's latest deployment of the head commit; GitHub lists them oldest first. */
function latestDeployments(pr: Source) {
  const latest = new Map<string, { environment: string; state: string; url: string | null }>();
  for (const node of pr.commits?.nodes ?? [])
    for (const entry of node?.commit.deployments.nodes ?? []) {
      if (!entry) continue;
      latest.set(entry.environment, {
        environment: entry.environment,
        state: entry.latestStatus?.state ?? entry.state ?? "UNKNOWN",
        url: entry.latestStatus?.environmentUrl || null,
      });
    }
  return [...latest.values()].slice(0, 10);
}

function mapState(pr: Source, permission: string | null, raw: unknown): ForgeMergeState {
  const rules = branchRules(pr);
  const blockers: string[] = [];
  if (pr.isDraft) blockers.push("This pull request is a draft.");
  if (pr.state !== "OPEN") blockers.push(`Pull request state: ${pr.state}.`);
  const reviews = reviewsRequired(pr);
  if (reviews) blockers.push(reviews);
  if (pr.reviewDecision === "CHANGES_REQUESTED") blockers.push("A review requests changes.");
  if (pr.statusCheckRollup && pr.statusCheckRollup.state !== "SUCCESS")
    blockers.push(`Checks: ${pr.statusCheckRollup.state}.`);
  if (pr.mergeStateStatus === "BEHIND") blockers.push("The branch is behind its base.");
  else if (pr.mergeStateStatus === "BLOCKED")
    blockers.push(...rules.filter((rule) => rule !== reviews));
  else if (pr.mergeStateStatus !== "CLEAN")
    blockers.push(`GitHub merge rules: ${pr.mergeStateStatus}.`);
  if (pr.mergeQueueEntry)
    blockers.push(
      `Merge queue: ${pr.mergeQueueEntry.state}, position ${pr.mergeQueueEntry.position}.`,
    );
  return ForgeMergeState.parse({
    headSha: pr.headRefOid,
    state: pr.isDraft ? "DRAFT" : pr.state,
    mergeState: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    checksState: pr.statusCheckRollup?.state ?? null,
    autoMerge: pr.autoMergeRequest
      ? {
          method: pr.autoMergeRequest.mergeMethod,
          actor: pr.autoMergeRequest.enabledBy?.login ?? null,
          enabledAt: pr.autoMergeRequest.enabledAt,
        }
      : null,
    queue: pr.mergeQueueEntry,
    rules,
    deployments: latestDeployments(pr),
    canEnable: pr.state === "OPEN" && !pr.isDraft && pr.viewerCanEnableAutoMerge,
    canDisable: pr.viewerCanDisableAutoMerge,
    canDequeue:
      pr.mergeQueueEntry !== null && ["WRITE", "MAINTAIN", "ADMIN"].includes(permission ?? ""),
    blockers,
    raw,
  });
}
export class GitHubMergeState {
  constructor(privateApi: GhApi, repository: ForgeRepository) {
    this.#api = privateApi;
    this.#repository = repository;
  }
  readonly #api: GhApi;
  readonly #repository: ForgeRepository;
  #extended = true;
  async #request(document: string, number: number, signal: AbortSignal): Promise<Page> {
    return this.#api.request("graphql", signal, {
      query: document,
      variables: { owner: this.#repository.owner, name: this.#repository.name, number },
    });
  }
  async #read(number: number, signal: AbortSignal) {
    z.number().int().positive().parse(number);
    let page: Page;
    try {
      page = await this.#request(this.#extended ? query : baseQuery, number, signal);
    } catch (error) {
      // A host without the rule and deployment fields refuses the document itself, and will
      // again: the base fields still answer. An unreadable answer is not that, and fails.
      if (!this.#extended || !(error instanceof ForgeQueryRefused)) throw error;
      page = await this.#request(baseQuery, number, signal);
      this.#extended = false;
    }
    const parsed = responseSchema.safeParse(page.body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    const repo = parsed.data.data.repository;
    const pr = repo?.pullRequest;
    if (!repo || !pr) throw new ForgeError("not_found");
    if (pr.number !== number) throw new ForgeError("invalid_data");
    return { pr, state: mapState(pr, repo.viewerPermission, page.body) };
  }
  async read(number: number, signal: AbortSignal) {
    return (await this.#read(number, signal)).state;
  }
  async change(
    number: number,
    headSha: string,
    action: "enable" | "disable" | "dequeue",
    method: MergeMethod,
    signal: AbortSignal,
    allowed: () => boolean = () => true,
    dispatch = new WriteDispatch(),
  ): Promise<ForgeMergeState | undefined> {
    z.string()
      .regex(/^[a-fA-F0-9]{40,64}$/)
      .parse(headSha);
    z.enum(["merge", "squash", "rebase"]).parse(method);
    z.enum(["enable", "disable", "dequeue"]).parse(action);
    const { pr, state } = await this.#read(number, signal);
    if (!allowed()) throw new ForgeError("forbidden", undefined, false);
    if (state.headSha !== headSha) throw new ForgeError("conflict", undefined, false);
    // Reconcile an already completed action before issuing another write.
    if (action === "enable" && (state.queue || state.autoMerge?.method === method.toUpperCase()))
      return state;
    if (action === "disable" && !state.autoMerge) return state;
    if (action === "dequeue" && !state.queue) return state;
    if (
      !(action === "enable"
        ? state.canEnable
        : action === "disable"
          ? state.canDisable
          : state.canDequeue)
    )
      throw new ForgeError("forbidden", undefined, false);
    const mutation =
      action === "enable"
        ? "enablePullRequestAutoMerge"
        : action === "disable"
          ? "disablePullRequestAutoMerge"
          : "dequeuePullRequest";
    const input =
      action === "enable"
        ? { pullRequestId: pr.id, expectedHeadOid: headSha, mergeMethod: method.toUpperCase() }
        : action === "disable"
          ? { pullRequestId: pr.id }
          : { id: pr.id };
    // Cancellation mutations have no expectedHeadOid in GitHub's documented contract;
    // the authoritative preflight above checks it, and GitHub enforces permissions.
    let failure: unknown;
    try {
      const page = await this.#api.request(
        "graphql",
        signal,
        {
          query: `mutation($input:${mutation[0]?.toUpperCase()}${mutation.slice(1)}Input!){${mutation}(input:$input){pullRequest{id}}}`,
          variables: { input },
        },
        "POST",
        dispatch,
      );
      const result = z
        .object({
          data: z.object({
            [mutation]: z.object({ pullRequest: z.object({ id: text }) }),
          }),
        })
        .safeParse(page.body);
      if (!result.success || result.data.data[mutation]?.pullRequest.id !== pr.id)
        throw new ForgeMutationOutcome({ number, headSha });
      if (page.identityChanged) throw new ForgeMutationOutcome({ number, headSha });
      // Return the acknowledgement before any read. The shell persists acceptance
      // before fetching host state, which may fail or lag behind this write.
      return undefined;
    } catch (error) {
      if (dispatch.definitelyFailed) throw error;
      failure = error;
    }
    // A read cannot turn an ambiguous mutation into a definite refusal.
    let current: ForgeMergeState;
    try {
      current = await this.read(number, signal);
    } catch {
      throw failure;
    }
    if (!mergeStateChangeObserved(current, headSha, action, method)) throw failure;
    return current;
  }
}
