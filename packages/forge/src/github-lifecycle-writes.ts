import { z } from "zod";
import type { ForgeLifecycleAction, ForgeLifecycleSnapshot } from "@ace/protocol/forge-lifecycle";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { GhApi } from "./http.ts";
import type { WriteDispatch } from "./write-dispatch.ts";
import { ForgeError } from "./errors.ts";
import { ForgeMutationOutcome } from "./mutation.ts";

const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);

/** The writes GitHub takes outside `updatePullRequest`: lock, head branch, issue links, milestone. */
export type ExtraLifecycleAction = Extract<
  ForgeLifecycleAction,
  {
    kind: "lock" | "unlock" | "branch.delete" | "branch.restore" | "issue.link" | "issue.unlink";
  }
>;
const extraKinds: ReadonlySet<ForgeLifecycleAction["kind"]> = new Set([
  "lock",
  "unlock",
  "branch.delete",
  "branch.restore",
  "issue.link",
  "issue.unlink",
]);
export function isExtraLifecycleAction(
  action: ForgeLifecycleAction,
): action is ExtraLifecycleAction {
  return extraKinds.has(action.kind);
}

/** REST's names for GitHub's lock reasons. */
const restReasons = {
  off_topic: "off-topic",
  too_heated: "too heated",
  resolved: "resolved",
  spam: "spam",
} as const;

/** A branch name as a REST path, each segment escaped and the slashes kept. */
export function branchPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

/**
 * Sends one lifecycle write that isn't an `updatePullRequest` field. Resolves once GitHub
 * acknowledged it; the caller observes the result in a fresh snapshot. Lookups before the write
 * are reads and never dispatch it.
 */
export class GitHubLifecycleWrites {
  readonly #api: GhApi;
  readonly #repository: ForgeRepository;
  readonly #root: string;
  constructor(api: GhApi, repository: ForgeRepository) {
    this.#api = api;
    this.#repository = repository;
    this.#root = `repos/${repository.owner}/${repository.name}`;
  }
  /** The issue's node id, read before any write so a missing issue refuses cleanly. */
  async #issueId(owner: string, name: string, number: number, signal: AbortSignal) {
    const response = await this.#api.request("graphql", signal, {
      query: `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id number}}}`,
      variables: { owner, name, number },
    });
    const parsed = z
      .object({
        data: z.object({
          repository: z
            .object({
              issue: z.looseObject({ id: text, number: z.number().int() }).nullable(),
            })
            .nullable(),
        }),
      })
      .safeParse(response.body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    const issue = parsed.data.data.repository?.issue;
    // A pull request number isn't an issue to close.
    if (!issue || issue.number !== number) throw new ForgeError("not_found");
    return issue.id;
  }
  /** The head branch's commit now, or null when it is gone. */
  async headCommit(branch: string, signal: AbortSignal): Promise<string | null> {
    try {
      const response = await this.#api.request(
        `${this.#root}/git/ref/heads/${branchPath(branch)}`,
        signal,
      );
      const parsed = z.looseObject({ object: z.looseObject({ sha }) }).safeParse(response.body);
      if (!parsed.success) throw new ForgeError("invalid_data");
      return parsed.data.object.sha;
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "not_found") return null;
      throw error;
    }
  }
  /**
   * Reads what the write needs (the issue's id, the branch's commit) and returns the write
   * itself, so the caller's last recheck sits between the two with no read after it.
   */
  async prepare(
    snapshot: ForgeLifecycleSnapshot,
    action: ExtraLifecycleAction,
    operationId: string,
    signal: AbortSignal,
  ): Promise<(dispatch: WriteDispatch) => Promise<void>> {
    const head = snapshot.headBranch;
    if (action.kind === "lock")
      return (dispatch) =>
        this.#rest(
          `${this.#root}/issues/${snapshot.pr.number}/lock`,
          "PUT",
          action.reason ? { lock_reason: restReasons[action.reason] } : {},
          signal,
          dispatch,
        );
    if (action.kind === "unlock")
      return (dispatch) =>
        this.#rest(
          `${this.#root}/issues/${snapshot.pr.number}/lock`,
          "DELETE",
          undefined,
          signal,
          dispatch,
        );
    if (action.kind === "branch.delete" || action.kind === "branch.restore") {
      if (!head) throw new ForgeError("unsupported");
      const current = await this.headCommit(head.name, signal);
      if (action.kind === "branch.restore") {
        // Someone recreated it meanwhile: there is nothing to restore.
        if (current !== null) throw new ForgeError("conflict");
        return (dispatch) =>
          this.#rest(
            `${this.#root}/git/refs`,
            "POST",
            { ref: `refs/heads/${head.name}`, sha: snapshot.headSha },
            signal,
            dispatch,
          );
      }
      if (current === null) throw new ForgeError("head_missing");
      // A branch that moved past the PR's head holds commits the PR doesn't: keep it.
      if (current.toLowerCase() !== snapshot.headSha.toLowerCase())
        throw new ForgeError("head_moved");
      return (dispatch) =>
        this.#rest(
          `${this.#root}/git/refs/heads/${branchPath(head.name)}`,
          "DELETE",
          undefined,
          signal,
          dispatch,
        );
    }
    if (action.kind === "issue.link") {
      const issueId = await this.#issueId(
        this.#repository.owner,
        this.#repository.name,
        action.issue,
        signal,
      );
      return (dispatch) =>
        this.#closing("addCloseIssueReferences", issueId, snapshot.id, operationId, signal, dispatch);
    }
    const target = action.issue;
    const linked = snapshot.closingIssues?.find(
      (issue) =>
        issue.ref.number === target.number &&
        issue.ref.repository.owner.toLowerCase() === target.repository.owner.toLowerCase() &&
        issue.ref.repository.name.toLowerCase() === target.repository.name.toLowerCase(),
    );
    // Keyword links live in the body; GitHub only removes hand-made ones.
    if (!linked?.manual) throw new ForgeError("forbidden");
    const issueId = await this.#issueId(
      target.repository.owner,
      target.repository.name,
      target.number,
      signal,
    );
    return (dispatch) =>
      this.#closing("removeCloseIssueReferences", issueId, snapshot.id, operationId, signal, dispatch);
  }
  async #rest(
    path: string,
    method: "PUT" | "POST" | "DELETE",
    body: unknown,
    signal: AbortSignal,
    dispatch: WriteDispatch,
  ): Promise<void> {
    const response = await this.#api.request(path, signal, body, method, dispatch);
    if (response.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
  }
  async #closing(
    mutation: "addCloseIssueReferences" | "removeCloseIssueReferences",
    issueId: string,
    pullRequestId: string,
    operationId: string,
    signal: AbortSignal,
    dispatch: WriteDispatch,
  ): Promise<void> {
    const type = `${mutation[0]?.toUpperCase()}${mutation.slice(1)}Input`;
    const response = await this.#api.request(
      "graphql",
      signal,
      {
        query: `mutation($input:${type}!){${mutation}(input:$input){clientMutationId issue{id}}}`,
        variables: {
          input: { issueId, pullRequestIds: [pullRequestId], clientMutationId: operationId },
        },
      },
      "POST",
      dispatch,
    );
    if (response.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
    const parsed = z
      .object({ data: z.record(z.string(), z.looseObject({ issue: z.looseObject({ id: text }) })) })
      .safeParse(response.body);
    if (!parsed.success || parsed.data.data[mutation]?.issue.id !== issueId)
      throw new ForgeMutationOutcome({ dispatched: true });
  }
}
