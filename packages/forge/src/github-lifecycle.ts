import { WriteDispatch } from "./write-dispatch.ts";
import { ForgeMutationOutcome } from "./mutation.ts";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  ForgeLifecycleSnapshot,
  ForgeLifecycleAction,
  type ForgeLifecycleReceipt,
} from "@ace/protocol/forge-lifecycle";
import { ForgePrRef, type ForgeRepository } from "@ace/protocol/forge";
import { GhApi } from "./http.ts";
import { ForgeError, ForgeQueryRefused } from "./errors.ts";
import { mapLifecycleExtras } from "./github-lifecycle-extras.ts";
import { GitHubLifecycleWrites, isExtraLifecycleAction } from "./github-lifecycle-writes.ts";
import {
  lifecycleCapabilities,
  assertLifecycleAction,
  lifecycleMutations,
  metadataMatches,
} from "./lifecycle-plan.ts";
import {
  LifecycleExtras,
  LifecycleHost,
  SupportedMutations,
  lifecycleExtraPrFields,
  lifecycleExtraRepositoryFields,
  lifecyclePrFields,
} from "./github-lifecycle-schemas.ts";
import { ReadBudget } from "./read-budget.ts";
const text = z.string().max(65_536);
function decode<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ForgeError("invalid_data");
  return result.data;
}
/** The snapshot query, with the milestone, lock, branch and closing-issue fields or without. */
function snapshotDocument(extended: boolean) {
  return `query AceLifecycleSnapshot($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){isArchived viewerPermission ${extended ? lifecycleExtraRepositoryFields : ""} pullRequest(number:$number){${lifecyclePrFields} ${extended ? lifecycleExtraPrFields : ""}}} mutationType:__type(name:"Mutation"){fields{name}}}`;
}
export function lifecycleWriteMarker(operationId: string) {
  return `<!-- ace-revert:${createHash("sha256").update(operationId).digest("hex")} -->`;
}
/** Labels and people an edit names, with GitHub's ids and spelling. */
type ResolvedNames = {
  labels?: { id: string; name: string }[];
  assignees?: { id: string; login: string }[];
};
/** Single GitHub lifecycle action owner. It owns capability discovery, preconditions and observation. */
export class GitHubLifecycle {
  readonly #api: GhApi;
  readonly #repository: ForgeRepository;
  readonly #writes: GitHubLifecycleWrites;
  /** Whether the host answers the milestone, lock, branch and closing-issue fields. */
  #extended = true;
  constructor(api: GhApi, repository: ForgeRepository) {
    this.#api = api;
    this.#repository = repository;
    this.#writes = new GitHubLifecycleWrites(api, repository);
  }
  async #snapshotQuery(number: number, signal: AbortSignal) {
    const variables = { owner: this.#repository.owner, name: this.#repository.name, number };
    if (this.#extended)
      try {
        return {
          response: await this.#graphql(snapshotDocument(true), variables, signal),
          extended: true,
        };
      } catch (error) {
        // A host without these fields refuses the document itself, and will again.
        if (!(error instanceof ForgeQueryRefused)) throw error;
        this.#extended = false;
      }
    return {
      response: await this.#graphql(snapshotDocument(false), variables, signal),
      extended: false,
    };
  }
  async #graphql(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
    dispatch?: WriteDispatch,
  ) {
    const response = await this.#api.request(
      "graphql",
      signal,
      { query, variables },
      "POST",
      dispatch,
    );
    if (response.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
    return response;
  }
  async snapshot(number: number, signal: AbortSignal): Promise<ForgeLifecycleSnapshot> {
    const pr = ForgePrRef.parse({ repository: this.#repository, number });
    // The host's mutations come in the same query: one round trip, not two in a row.
    const { response, extended } = await this.#snapshotQuery(number, signal);
    const repository = decode(LifecycleHost, response.body).data.repository;
    // These facts only add controls: an answer without them leaves those controls out.
    const extraFacts = extended ? LifecycleExtras.safeParse(response.body) : undefined;
    const extras = extraFacts?.success
      ? mapLifecycleExtras(
          this.#repository,
          extraFacts.data.data.repository,
          repository.viewerPermission,
          number,
        )
      : undefined;
    const raw = repository.pullRequest;
    if (raw.number !== number) throw new ForgeError("invalid_data");
    if (raw.labels.pageInfo.hasNextPage || raw.assignees.pageInfo.hasNextPage)
      throw new ForgeError("limit");
    const supported = decode(SupportedMutations, response.body).data.mutationType.fields;
    const state =
      raw.state === "MERGED"
        ? "merged"
        : raw.state === "CLOSED"
          ? "closed"
          : raw.state === "OPEN"
            ? raw.isDraft
              ? "draft"
              : "open"
            : undefined;
    if (!state) throw new ForgeError("unsupported");
    const metadata = {
      title: raw.title,
      body: raw.body,
      baseBranch: raw.baseRefName,
      labels: raw.labels.nodes.map((l) => l.name).toSorted(),
      assignees: raw.assignees.nodes.map((u) => u.login).toSorted(),
      ...(extras ? { milestone: extras.fields.milestone?.number ?? null } : {}),
    };
    const version = createHash("sha256")
      .update(
        JSON.stringify({
          id: raw.id,
          metadata,
          head: raw.headRefOid,
          base: raw.baseRefOid,
          state,
          isDraft: raw.isDraft,
          updatedAt: raw.updatedAt,
          mergeCommit: raw.mergeCommit?.oid,
          extras: extras?.fields,
        }),
      )
      .digest("hex");
    return ForgeLifecycleSnapshot.parse({
      pr,
      id: raw.id,
      version,
      headSha: raw.headRefOid,
      baseSha: raw.baseRefOid,
      state,
      metadata,
      ...extras?.fields,
      ...lifecycleCapabilities({
        state,
        archived: repository.isArchived,
        canUpdate: raw.viewerCanUpdate,
        canClose: raw.viewerCanClose,
        canReopen: raw.viewerCanReopen,
        canLabel: raw.viewerCanLabel,
        canAssign: raw.viewerCanAssign,
        canUpdateBranch: raw.viewerCanUpdateBranch,
        rebaseable: raw.canBeRebased,
        canRevert:
          Boolean(raw.mergeCommit) &&
          ["ADMIN", "MAINTAIN", "WRITE"].includes(repository.viewerPermission ?? ""),
        supported: new Set(supported.map((f) => f.name)),
        permission: repository.viewerPermission,
        extras: extras?.facts,
      }),
    });
  }
  /**
   * The labels and people an edit names, as this repository has them. One lookup for both edit
   * paths, so a name GitHub doesn't know refuses the edit (`conflict`) however it is sent.
   */
  async #resolveNames(
    changes: Extract<ForgeLifecycleAction, { kind: "edit" }>["changes"],
    signal: AbortSignal,
  ): Promise<ResolvedNames> {
    const labels = changes.labels ?? [];
    const assignees = changes.assignees ?? [];
    const resolved: ResolvedNames = {};
    if (changes.labels) resolved.labels = [];
    if (changes.assignees) resolved.assignees = [];
    if (!labels.length && !assignees.length) return resolved;
    // Names remain literal GraphQL strings and cannot expand repository scope.
    const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${labels.map((l, i) => `l${i}:label(name:${JSON.stringify(l)}){id name}`).join(" ")} id} ${assignees.map((u, i) => `u${i}:user(login:${JSON.stringify(u)}){id login}`).join(" ")}}`;
    const result = decode(
      z.object({ data: z.record(z.string(), z.unknown()) }),
      (
        await this.#graphql(
          query,
          { owner: this.#repository.owner, name: this.#repository.name },
          signal,
        )
      ).body,
    ).data;
    const repo = decode(z.record(z.string(), z.unknown()), result.repository);
    if (changes.labels)
      resolved.labels = labels.map((name, i) => {
        // GitHub answers null for a name it doesn't have.
        if (repo[`l${i}`] === null) throw new ForgeError("unprocessable");
        const label = decode(z.object({ id: text, name: text }), repo[`l${i}`]);
        if (label.name !== name) throw new ForgeError("conflict");
        return { id: label.id, name: label.name };
      });
    if (changes.assignees)
      resolved.assignees = assignees.map((login, i) => {
        if (result[`u${i}`] === null) throw new ForgeError("unprocessable");
        const user = decode(z.object({ id: text, login: text }), result[`u${i}`]);
        if (user.login.toLowerCase() !== login.toLowerCase()) throw new ForgeError("conflict");
        return { id: user.id, login: user.login };
      });
    return resolved;
  }
  async #editInput(
    snapshot: ForgeLifecycleSnapshot,
    changes: Extract<ForgeLifecycleAction, { kind: "edit" }>["changes"],
    signal: AbortSignal,
  ) {
    const input: Record<string, unknown> = { pullRequestId: snapshot.id };
    if (changes.title !== undefined) input.title = changes.title;
    if (changes.body !== undefined) input.body = changes.body;
    if (changes.baseBranch !== undefined) input.baseRefName = changes.baseBranch;
    const names = await this.#resolveNames(changes, signal);
    if (names.labels) input.labelIds = names.labels.map((label) => label.id);
    if (names.assignees) input.assigneeIds = names.assignees.map((user) => user.id);
    return input;
  }
  async apply(
    number: number,
    expectedVersion: string,
    rawAction: ForgeLifecycleAction,
    operationId: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ): Promise<ForgeLifecycleReceipt> {
    const action = ForgeLifecycleAction.parse(rawAction);
    const snapshot = await this.snapshot(number, signal);
    assertLifecycleAction(snapshot, expectedVersion, action);
    if (isExtraLifecycleAction(action))
      return this.#send(
        number,
        expectedVersion,
        action,
        snapshot,
        operationId,
        signal,
        allowed,
        () => this.#writes.prepare(snapshot, action, operationId, signal),
        dispatch,
      );
    if (action.kind === "edit" && action.changes.milestone !== undefined)
      return this.#send(
        number,
        expectedVersion,
        action,
        snapshot,
        operationId,
        signal,
        allowed,
        async () => {
          // GitHub sets a milestone through the issue behind the PR, which takes these fields too.
          const { milestone, baseBranch, title, body: description } = action.changes;
          if (baseBranch !== undefined) throw new ForgeError("invalid_data");
          // The same name check as an edit without a milestone, then GitHub's own spelling.
          const names = await this.#resolveNames(action.changes, signal);
          const body = {
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { body: description }),
            ...(names.labels ? { labels: names.labels.map((label) => label.name) } : {}),
            ...(names.assignees ? { assignees: names.assignees.map((user) => user.login) } : {}),
            milestone,
          };
          return (writeDispatch: WriteDispatch) =>
            this.#api
              .request(
                `repos/${this.#repository.owner}/${this.#repository.name}/issues/${number}`,
                signal,
                body,
                "PATCH",
                writeDispatch,
              )
              .then((response) => {
                if (response.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
              });
        },
        dispatch,
      );
    let mutation: string;
    let input: Record<string, unknown> = {
      pullRequestId: snapshot.id,
      clientMutationId: operationId,
    };
    if (action.kind === "edit") {
      mutation = "updatePullRequest";
      input = { ...input, ...(await this.#editInput(snapshot, action.changes, signal)) };
    } else {
      mutation = lifecycleMutations[action.kind];
      if (action.kind === "revert")
        input = {
          ...input,
          title: action.title,
          body: `${action.body}\n\n${lifecycleWriteMarker(operationId)}`,
          draft: true,
        };
      if (action.kind === "update.merge" || action.kind === "update.rebase")
        input = {
          ...input,
          expectedHeadOid: snapshot.headSha,
          updateMethod: action.kind === "update.rebase" ? "REBASE" : "MERGE",
        };
    }
    // Lookup awaits may have changed host facts or authorisation. Recheck just before writing.
    const latest = await this.snapshot(number, signal);
    assertLifecycleAction(latest, expectedVersion, action);
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    const type = `${mutation[0]?.toUpperCase()}${mutation.slice(1)}Input`;
    const fields =
      action.kind === "revert" ? "revertPullRequest { number }" : "pullRequest { headRefOid }";
    const response = await this.#graphql(
      `mutation($input:${type}!){${mutation}(input:$input){clientMutationId ${fields}}}`,
      { input },
      signal,
      dispatch,
    );
    try {
      const data = decode(
        z.object({ data: z.record(z.string(), z.unknown()) }),
        response.body,
      ).data;
      if (action.kind === "revert") {
        const result = decode(
          z.object({ revertPullRequest: z.object({ number: z.number().int().positive() }) }),
          data[mutation],
        );
        const revertPr = { repository: this.#repository, number: result.revertPullRequest.number };
        if (revertPr.number === number) throw new ForgeError("invalid_data");
        return { outcome: "accepted", headSha: snapshot.headSha, revertPr };
      }
      const result = decode(
        z.object({ pullRequest: z.object({ headRefOid: text }) }),
        data[mutation],
      );
      const current = await this.snapshot(number, signal);
      if (action.kind.startsWith("update.") && current.headSha !== result.pullRequest.headRefOid)
        return { outcome: "head_changed", headSha: current.headSha };
      const observed = await this.observe(number, action, snapshot, operationId, signal);
      return observed ?? { outcome: "pending", headSha: current.headSha };
    } catch (error) {
      throw new Error("action_outcome_uncertain", { cause: error });
    }
  }
  /**
   * One write outside `updatePullRequest`: its reads first, then the same recheck as every
   * lifecycle write, the write, and an observed result. Once sent, a failure is uncertain.
   */
  async #send(
    number: number,
    expectedVersion: string,
    action: ForgeLifecycleAction,
    snapshot: ForgeLifecycleSnapshot,
    operationId: string,
    signal: AbortSignal,
    allowed: () => boolean,
    prepare: () => Promise<(dispatch: WriteDispatch) => Promise<void>>,
    dispatch: WriteDispatch,
  ): Promise<ForgeLifecycleReceipt> {
    const write = await prepare();
    const latest = await this.snapshot(number, signal);
    assertLifecycleAction(latest, expectedVersion, action);
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    await write(dispatch);
    try {
      const observed = await this.observe(number, action, snapshot, operationId, signal);
      return observed ?? { outcome: "pending", headSha: snapshot.headSha };
    } catch (error) {
      throw new Error("action_outcome_uncertain", { cause: error });
    }
  }
  async observe(
    number: number,
    action: ForgeLifecycleAction,
    before: ForgeLifecycleSnapshot,
    operationId: string,
    signal: AbortSignal,
  ): Promise<ForgeLifecycleReceipt | null> {
    if (action.kind === "revert") {
      const path = `repos/${this.#repository.owner}/${this.#repository.name}/pulls?state=all&sort=created&direction=desc&per_page=100`;
      const budget = new ReadBudget();
      let endpoint: string | undefined = path;
      // Search a bounded recent window and stop as soon as the unique marker is observed.
      for (let page = 0; endpoint && page < 20; page++) {
        const response = await this.#api.request(endpoint, signal);
        budget.add(response.bytes);
        const prs = decode(
          z
            .array(
              z.looseObject({
                number: z.number().int().positive(),
                body: text.nullable(),
                title: text,
              }),
            )
            .max(100),
          response.body,
        );
        const found = prs.filter(
          (pr) =>
            pr.body?.includes(lifecycleWriteMarker(operationId)) &&
            pr.title === action.title &&
            pr.number !== number,
        );
        if (found.length > 1) throw new ForgeError("conflict");
        if (found[0])
          return {
            outcome: "accepted",
            headSha: before.headSha,
            revertPr: { repository: this.#repository, number: found[0].number },
          };
        endpoint = this.#api.next(response, path);
      }
      // Absence within the window is uncertain and never permits another revert write.
      return null;
    }
    const current = await this.snapshot(number, signal);
    if (action.kind === "edit")
      return metadataMatches(current, action.changes)
        ? { outcome: "accepted", headSha: current.headSha }
        : null;
    if (action.kind.startsWith("update.")) {
      if (current.baseSha !== before.baseSha)
        return { outcome: "head_changed", headSha: current.headSha };
      if (current.headSha === before.headSha) return null;
      const compare = decode(
        z.looseObject({ behind_by: z.number().int().nonnegative() }),
        (
          await this.#api.request(
            `repos/${this.#repository.owner}/${this.#repository.name}/compare/${before.baseSha}...${current.headSha}`,
            signal,
          )
        ).body,
      );
      const latest = await this.snapshot(number, signal);
      if (latest.headSha !== current.headSha || latest.baseSha !== current.baseSha)
        return { outcome: "head_changed", headSha: latest.headSha };
      return compare.behind_by === 0
        ? { outcome: "accepted", headSha: current.headSha }
        : { outcome: "head_changed", headSha: current.headSha };
    }
    const done = { outcome: "accepted" as const, headSha: current.headSha };
    if (action.kind === "lock" || action.kind === "unlock")
      return current.conversation?.locked === (action.kind === "lock") ? done : null;
    if (action.kind === "branch.delete" || action.kind === "branch.restore")
      return current.headBranch?.exists === (action.kind === "branch.restore") ? done : null;
    if (action.kind === "issue.link" || action.kind === "issue.unlink") {
      const { owner, name } =
        action.kind === "issue.link" ? this.#repository : action.issue.repository;
      const issue = action.kind === "issue.link" ? action.issue : action.issue.number;
      const linked = (current.closingIssues ?? []).some(
        (each) =>
          each.ref.number === issue &&
          each.ref.repository.owner.toLowerCase() === owner.toLowerCase() &&
          each.ref.repository.name.toLowerCase() === name.toLowerCase() &&
          (action.kind === "issue.link" || each.manual),
      );
      return linked === (action.kind === "issue.link") ? done : null;
    }
    if (action.kind === "reopen")
      return current.state === "open" || current.state === "draft"
        ? { outcome: "accepted", headSha: current.headSha }
        : null;
    const target = { ready: "open", draft: "draft", close: "closed" };
    const expected = target[action.kind as keyof typeof target];
    return current.state === expected ? { outcome: "accepted", headSha: current.headSha } : null;
  }
}
