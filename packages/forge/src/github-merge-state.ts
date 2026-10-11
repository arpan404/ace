import { z } from "zod";
import { ForgeMergeState } from "@ace/protocol/forge-merge-state";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";
import type { MergeMethod } from "./api.ts";

const text = z.string().max(65_536);
const actor = z.looseObject({ login: text });
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
    })
    .nullable(),
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
const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){viewerPermission pullRequest(number:$number){id number headRefOid state isDraft mergeStateStatus reviewDecision statusCheckRollup{state} autoMergeRequest{mergeMethod enabledAt enabledBy{login}} mergeQueueEntry{id state position enqueuedAt} viewerCanEnableAutoMerge viewerCanDisableAutoMerge}}}`;

/** HTTP 200 can still contain a GraphQL failure. Never accept partial mutation data. */
export function checkedGraphql(body: unknown): unknown {
  const envelope = z
    .looseObject({
      errors: z
        .array(z.looseObject({ type: text.optional() }))
        .max(100)
        .optional(),
    })
    .safeParse(body);
  if (!envelope.success) throw new ForgeError("invalid_data");
  if (envelope.data.errors?.length) {
    const types = new Set(envelope.data.errors.map((error) => error.type));
    if (types.has("RATE_LIMITED")) throw new ForgeError("rate_limit");
    if (types.has("FORBIDDEN") || types.has("UNAUTHORIZED")) throw new ForgeError("forbidden");
    if (types.has("NOT_FOUND")) throw new ForgeError("not_found");
    throw new ForgeError("unsupported");
  }
  return body;
}
function mapState(
  pr: z.infer<typeof source>,
  permission: string | null,
  raw: unknown,
): ForgeMergeState {
  const blockers: string[] = [];
  if (pr.isDraft) blockers.push("This pull request is a draft.");
  if (pr.state !== "OPEN") blockers.push(`Pull request state: ${pr.state}.`);
  if (pr.reviewDecision === "REVIEW_REQUIRED") blockers.push("Required reviews are outstanding.");
  if (pr.reviewDecision === "CHANGES_REQUESTED") blockers.push("A review requests changes.");
  if (pr.statusCheckRollup && pr.statusCheckRollup.state !== "SUCCESS")
    blockers.push(`Checks: ${pr.statusCheckRollup.state}.`);
  if (pr.mergeStateStatus !== "CLEAN") blockers.push(`GitHub merge rules: ${pr.mergeStateStatus}.`);
  if (pr.mergeQueueEntry) blockers.push(`Merge queue: ${pr.mergeQueueEntry.state}.`);
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
  async #read(number: number, signal: AbortSignal) {
    z.number().int().positive().parse(number);
    const page = await this.#api.request("graphql", signal, {
      query,
      variables: { owner: this.#repository.owner, name: this.#repository.name, number },
    });
    const parsed = responseSchema.safeParse(checkedGraphql(page.body));
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
  ) {
    z.string()
      .regex(/^[a-fA-F0-9]{40,64}$/)
      .parse(headSha);
    z.enum(["merge", "squash", "rebase"]).parse(method);
    z.enum(["enable", "disable", "dequeue"]).parse(action);
    const { pr, state } = await this.#read(number, signal);
    if (!allowed()) throw new ForgeError("forbidden");
    if (state.headSha !== headSha) throw new ForgeError("conflict");
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
      throw new ForgeError("forbidden");
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
      const page = await this.#api.request("graphql", signal, {
        query: `mutation($input:${mutation[0]?.toUpperCase()}${mutation.slice(1)}Input!){${mutation}(input:$input){clientMutationId}}`,
        variables: { input },
      });
      const result = z
        .object({ data: z.record(z.string(), z.unknown()) })
        .safeParse(checkedGraphql(page.body));
      if (!result.success || !result.data.data[mutation]) throw new ForgeError("invalid_data");
    } catch (error) {
      failure = error;
    }
    // Never retry a write after a lost acknowledgement. Observe GitHub first.
    const current = await this.read(number, signal);
    const completed =
      action === "enable"
        ? current.autoMerge?.method === method.toUpperCase() ||
          current.queue !== null ||
          current.state === "MERGED"
        : action === "disable"
          ? current.autoMerge === null
          : current.queue === null;
    if (failure && !completed) throw failure;
    if (!completed) throw new ForgeError("conflict");
    return current;
  }
}
