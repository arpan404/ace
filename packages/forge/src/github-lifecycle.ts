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
import { ForgeError } from "./errors.ts";
import {
  lifecycleCapabilities,
  assertLifecycleAction,
  lifecycleMutations,
  metadataMatches,
} from "./lifecycle-plan.ts";
import {
  LifecycleHost,
  SupportedMutations,
  lifecyclePrFields,
} from "./github-lifecycle-schemas.ts";
import { ReadBudget } from "./read-budget.ts";
const text = z.string().max(65_536);
function decode<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ForgeError("invalid_data");
  return result.data;
}
export function lifecycleWriteMarker(operationId: string) {
  return `<!-- ace-revert:${createHash("sha256").update(operationId).digest("hex")} -->`;
}
/** Single GitHub lifecycle action owner. It owns capability discovery, preconditions and observation. */
export class GitHubLifecycle {
  readonly #api: GhApi;
  readonly #repository: ForgeRepository;
  constructor(api: GhApi, repository: ForgeRepository) {
    this.#api = api;
    this.#repository = repository;
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
    const response = await this.#graphql(
      `query AceLifecycleSnapshot($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){isArchived viewerPermission pullRequest(number:$number){${lifecyclePrFields}}}}`,
      { owner: this.#repository.owner, name: this.#repository.name, number },
      signal,
    );
    const repository = decode(LifecycleHost, response.body).data.repository;
    const raw = repository.pullRequest;
    if (raw.number !== number) throw new ForgeError("invalid_data");
    if (raw.labels.pageInfo.hasNextPage || raw.assignees.pageInfo.hasNextPage)
      throw new ForgeError("limit");
    const supported = decode(
      SupportedMutations,
      (await this.#graphql(`query{mutationType:__type(name:"Mutation"){fields{name}}}`, {}, signal))
        .body,
    ).data.mutationType.fields;
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
      }),
    });
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
    const labels = changes.labels ?? [];
    const assignees = changes.assignees ?? [];
    if (labels.length || assignees.length) {
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
        input.labelIds = labels.map((name, i) => {
          const label = decode(z.object({ id: text, name: text }), repo[`l${i}`]);
          if (label.name !== name) throw new ForgeError("conflict");
          return label.id;
        });
      if (changes.assignees)
        input.assigneeIds = assignees.map((login, i) => {
          const user = decode(z.object({ id: text, login: text }), result[`u${i}`]);
          if (user.login.toLowerCase() !== login.toLowerCase()) throw new ForgeError("conflict");
          return user.id;
        });
    }
    if (changes.labels?.length === 0) input.labelIds = [];
    if (changes.assignees?.length === 0) input.assigneeIds = [];
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
    if (action.kind === "reopen")
      return current.state === "open" || current.state === "draft"
        ? { outcome: "accepted", headSha: current.headSha }
        : null;
    const target = { ready: "open", draft: "draft", close: "closed" };
    const expected = target[action.kind as keyof typeof target];
    return current.state === expected ? { outcome: "accepted", headSha: current.headSha } : null;
  }
}
