import type { WriteDispatch } from "./write-dispatch.ts";
import { sameStack, stackPrState } from "./stack-plan.ts";
import { readStackMergeScope } from "./github-stack-scope.ts";
import { readStackChecks } from "./github-stack-checks.ts";
import { z } from "zod";
import {
  ForgeStack,
  ForgeStackMembership,
  ForgeStackExpected,
  ForgeStackLayer,
  type ForgeStackOperation,
} from "@ace/protocol/forge-stacks";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";
import type { MergeMethod } from "./api.ts";
const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const positive = z.number().int().positive();
const membership = z.looseObject({
  number: positive,
  stack: z
    .looseObject({ id: text, number: positive, baseRefName: text, size: positive.max(100) })
    .nullable(),
  stackEntry: z.looseObject({ position: positive.max(100) }).nullable(),
});
const memberFields = "number stack{id number baseRefName size} stackEntry{position}";
const layer = z.looseObject({
  number: positive,
  title: text,
  url: z.url().max(4096),
  headRefOid: sha,
  headRefName: text,
  baseRefName: text,
  state: text,
  isDraft: z.boolean(),
  mergeStateStatus: text,
  reviewDecision: text.nullable(),
  statusCheckRollup: z.looseObject({ state: text }).nullable(),
  mergeQueueEntry: z.looseObject({ state: text }).nullable(),
});
const stackSource = z.looseObject({
  id: text,
  number: positive,
  baseRefName: text,
  size: positive.max(100),
  entries: z.looseObject({
    nodes: z.array(z.looseObject({ position: positive, pullRequest: layer.nullable() })).max(100),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
const stateSchema = z.looseObject({
  data: z.object({
    repository: z
      .looseObject({
        viewerPermission: text.nullable(),
        pullRequest: z.looseObject({ number: positive, stack: stackSource.nullable() }).nullable(),
      })
      .nullable(),
  }),
  errors: z.array(z.unknown()).max(100).optional(),
});
const layerFields =
  "number title url headRefOid headRefName baseRefName state isDraft mergeStateStatus reviewDecision statusCheckRollup{state} mergeQueueEntry{state}";
const operationSchema = z.looseObject({
  status: text,
  details: z.looseObject({ uuid: z.uuid().optional(), message: text }),
});

function mergeOperation(body: unknown): ForgeStackOperation {
  const result = operationSchema.safeParse(body);
  if (!result.success || (result.data.status === "pending" && !result.data.details.uuid))
    throw new ForgeError("invalid_data");
  return {
    action: "merge",
    raw: body,
    state:
      result.data.status === "pending" ||
      result.data.status === "merged" ||
      result.data.status === "enqueued" ||
      result.data.status === "failed"
        ? result.data.status
        : "uncertain",
    message: result.data.details.message,
    ...(result.data.details.uuid ? { uuid: result.data.details.uuid } : {}),
  };
}
export class GitHubStacks {
  readonly #api: GhApi;
  readonly #repo: ForgeRepository;
  readonly #root: string;
  constructor(api: GhApi, repository: ForgeRepository) {
    this.#api = api;
    this.#repo = repository;
    this.#root = `repos/${repository.owner}/${repository.name}`;
  }
  async memberships(
    numbers: readonly number[],
    signal: AbortSignal,
  ): Promise<ForgeStackMembership[]> {
    z.array(positive).max(100).parse(numbers);
    const unique = [...new Set(numbers)];
    if (!unique.length) return [];
    const page = await this.#api.request("graphql", signal, {
      query: `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${unique.map((number) => `pr${number}:pullRequest(number:${number}){${memberFields}}`).join(" ")}}}`,
      variables: { owner: this.#repo.owner, name: this.#repo.name },
    });
    const result = z
      .object({
        data: z.object({ repository: z.record(z.string(), membership.nullable()).nullable() }),
        errors: z.array(z.unknown()).max(100).optional(),
      })
      .safeParse(page.body);
    if (!result.success) throw new ForgeError("invalid_data");
    if (!result.data.data.repository) throw new ForgeError("not_found");
    return unique.map((number) => {
      const pr = result.data.data.repository?.[`pr${number}`];
      if (pr === undefined || (pr && pr.number !== number) || (pr?.stack && !pr.stackEntry))
        throw new ForgeError("invalid_data");
      return ForgeStackMembership.parse({
        number,
        raw: pr,
        stack: pr?.stack
          ? {
              id: pr.stack.id,
              number: pr.stack.number,
              trunk: pr.stack.baseRefName,
              size: pr.stack.size,
              position: pr.stackEntry?.position,
            }
          : null,
      });
    });
  }
  mergeScope(numbers: readonly number[], signal: AbortSignal) {
    return readStackMergeScope(this.#api, this.#repo, numbers, signal);
  }
  async read(number: number, signal: AbortSignal): Promise<ForgeStack | null> {
    positive.parse(number);
    const page = await this.#api.request("graphql", signal, {
      query: `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){viewerPermission pullRequest(number:$number){number stack{id number baseRefName size entries(first:100){pageInfo{hasNextPage} nodes{position pullRequest{${layerFields}}}}}}}}`,
      variables: { owner: this.#repo.owner, name: this.#repo.name, number },
    });
    const result = stateSchema.safeParse(page.body);
    if (!result.success) throw new ForgeError("invalid_data");
    const repo = result.data.data.repository;
    if (!repo?.pullRequest) throw new ForgeError("not_found");
    if (repo.pullRequest.number !== number) throw new ForgeError("invalid_data");
    const stack = repo.pullRequest.stack;
    if (!stack) return null;
    if (stack.entries.pageInfo.hasNextPage) throw new ForgeError("limit");
    const nodes = stack.entries.nodes.toSorted((a, b) => a.position - b.position);
    if (nodes.length !== stack.size || !nodes.some((entry) => entry.pullRequest?.number === number))
      throw new ForgeError("invalid_data");
    const seen = new Set<number>();
    const layers = nodes.map((entry, index) => {
      const pr = entry.pullRequest;
      if (!pr || entry.position !== index + 1 || seen.has(pr.number))
        throw new ForgeError("invalid_data");
      if (
        pr.url.toLowerCase() !==
        `https://${this.#repo.host}/${this.#repo.owner}/${this.#repo.name}/pull/${pr.number}`.toLowerCase()
      )
        throw new ForgeError("invalid_data");
      seen.add(pr.number);
      return ForgeStackLayer.parse({
        number: pr.number,
        position: entry.position,
        title: pr.title,
        url: pr.url,
        headSha: pr.headRefOid,
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        state: stackPrState(pr),
        mergeState: pr.mergeStateStatus,
        reviewDecision: pr.reviewDecision,
        checksState: pr.statusCheckRollup?.state ?? null,
        queueState: pr.mergeQueueEntry?.state ?? null,
      });
    });
    const checks = await readStackChecks(this.#api, this.#repo, layers, signal);
    return ForgeStack.parse({
      id: stack.id,
      number: stack.number,
      trunk: stack.baseRefName,
      layers: checks.layers,
      canMerge: ["WRITE", "MAINTAIN", "ADMIN"].includes(repo.viewerPermission ?? ""),
      raw: { stack: page.body, checks: checks.raw },
    });
  }
  async merge(
    number: number,
    input: ForgeStackExpected,
    method: MergeMethod,
    signal: AbortSignal,
    allowed: () => boolean = () => true,
    dispatch?: WriteDispatch,
  ): Promise<ForgeStackOperation> {
    const expected = ForgeStackExpected.parse(input);
    z.enum(["merge", "squash", "rebase"]).parse(method);
    const stack = await this.read(number, signal);
    if (!stack || !sameStack(expected, stack)) throw new ForgeError("conflict");
    const position = stack.layers.findIndex((entry) => entry.number === number);
    const scope = stack.layers.slice(0, position + 1);
    const head = scope.at(-1)?.headSha;
    if (!head || !allowed()) throw new ForgeError("forbidden");
    if (scope.every((entry) => entry.state === "MERGED"))
      return {
        action: "merge",
        state: "merged",
        message: "GitHub reports all requested layers merged.",
      };
    if (scope.every((entry) => entry.state === "MERGED" || entry.queueState !== null))
      return {
        action: "merge",
        state: "enqueued",
        message: "GitHub reports the requested layers already queued.",
      };
    if (!stack.canMerge) throw new ForgeError("forbidden");
    if (scope.some((entry) => entry.state !== "OPEN" && entry.state !== "MERGED"))
      throw new ForgeError("conflict");
    // One native host operation includes the downstack, applies rules, and uses its queue.
    return mergeOperation(
      (
        await this.#api.request(
          `${this.#root}/pulls/${number}/merge-async`,
          signal,
          { sha: head, merge_method: method, merge_action: "default", bypass_rules: false },
          "PUT",
          dispatch,
        )
      ).body,
    );
  }
  async mergeResult(number: number, uuid: string, signal: AbortSignal) {
    positive.parse(number);
    z.uuid().parse(uuid);
    return mergeOperation(
      (await this.#api.request(`${this.#root}/pulls/${number}/merge-async/${uuid}`, signal)).body,
    );
  }
}
