import { z } from "zod";
import {
  ForgeLifecycleAction,
  type ForgeLifecycleSnapshot,
  type ForgeLifecycleReceipt,
} from "@ace/protocol/forge-lifecycle";
import { ForgePrRef } from "@ace/protocol/forge";
import { GitLabApi } from "./gitlab-api.ts";
import { ForgeError } from "./errors.ts";
import { decode } from "./gitlab-records.ts";
import { ForgeMutationOutcome } from "./mutation.ts";
import { ReadBudget } from "./read-budget.ts";
import type { HostApiWrite } from "./read-only-api.ts";
import type { WriteDispatch } from "./write-dispatch.ts";
import { assertLifecycleAction, metadataMatches } from "./lifecycle-plan.ts";
import {
  LifecycleMr,
  LifecycleProject,
  gitLabLifecycleSnapshot,
} from "./gitlab-lifecycle-records.ts";

export const gitLabLifecycleWrites: readonly HostApiWrite[] = [
  { method: "PUT", endpoint: /^projects\/[A-Za-z0-9%_.~-]+\/merge_requests\/[1-9]\d*$/ },
];
const Users = z
  .array(z.looseObject({ id: z.number().int().positive(), username: z.string() }))
  .max(100);
/** Lifecycle updates over an identity-checked glab runner. No automatic write retries. */
export class GitLabLifecycle {
  readonly api: GitLabApi;
  constructor(api: GitLabApi) {
    this.api = api;
  }
  async snapshot(number: number, signal: AbortSignal): Promise<ForgeLifecycleSnapshot> {
    ForgePrRef.parse({ repository: this.api.repository, number });
    const budget = new ReadBudget();
    const mr = decode(
      LifecycleMr,
      (await this.api.get(`${this.api.root}/merge_requests/${number}`, signal, budget)).body,
    );
    if (mr.iid !== number) throw new ForgeError("invalid_data");
    const project = decode(
      LifecycleProject,
      (await this.api.get(this.api.root, signal, budget)).body,
    );
    return gitLabLifecycleSnapshot(this.api.repository, mr, project);
  }
  async apply(
    number: number,
    expectedVersion: string,
    rawAction: ForgeLifecycleAction,
    _operationId: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ): Promise<ForgeLifecycleReceipt> {
    const action = ForgeLifecycleAction.parse(rawAction);
    const before = await this.snapshot(number, signal);
    assertLifecycleAction(before, expectedVersion, action);
    const body = await this.#body(before, action, signal);
    assertLifecycleAction(await this.snapshot(number, signal), expectedVersion, action);
    if (!allowed() || signal.aborted) throw new ForgeError("cancelled");
    await this.api.write(
      `${this.api.root}/merge_requests/${number}`,
      "PUT",
      body,
      signal,
      new ReadBudget(),
      dispatch,
    );
    try {
      return (
        (await this.observe(number, action, before, _operationId, signal)) ?? {
          outcome: "pending",
          headSha: before.headSha,
        }
      );
    } catch (error) {
      throw new ForgeMutationOutcome({
        dispatched: true,
        cause: error instanceof ForgeError ? error.kind : "cli",
      });
    }
  }
  async #body(
    before: ForgeLifecycleSnapshot,
    action: ForgeLifecycleAction,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (action.kind === "close" || action.kind === "reopen") return { state_event: action.kind };
    if (action.kind === "lock" || action.kind === "unlock") {
      if (action.kind === "lock" && action.reason !== null) throw new ForgeError("unsupported");
      return { discussion_locked: action.kind === "lock" };
    }
    if (action.kind === "ready" || action.kind === "draft") {
      const title = before.metadata.title.replace(/^(?:draft:|wip:|\[draft\]|\(draft\))\s*/i, "");
      return { title: action.kind === "draft" ? `Draft: ${title}` : title };
    }
    if (action.kind !== "edit") throw new ForgeError("unsupported");
    const changes = action.changes;
    if (changes.labels?.some((label) => label.includes(","))) throw new ForgeError("unprocessable");
    const body: Record<string, unknown> = {
      ...(changes.title === undefined ? {} : { title: changes.title }),
      ...(changes.body === undefined ? {} : { description: changes.body }),
      ...(changes.baseBranch === undefined ? {} : { target_branch: changes.baseBranch }),
      ...(changes.labels === undefined ? {} : { labels: changes.labels.join(",") }),
    };
    if (changes.assignees !== undefined) {
      const ids: number[] = [];
      for (const username of changes.assignees) {
        const users = decode(
          Users,
          (
            await this.api.get(
              `users?username=${encodeURIComponent(username)}`,
              signal,
              new ReadBudget(),
            )
          ).body,
        );
        const matches = users.filter(
          (user) => user.username.toLowerCase() === username.toLowerCase(),
        );
        if (matches.length !== 1 || !matches[0]) throw new ForgeError("unprocessable");
        ids.push(matches[0].id);
      }
      body.assignee_ids = ids;
    }
    return body;
  }
  async observe(
    number: number,
    action: ForgeLifecycleAction,
    _before: ForgeLifecycleSnapshot,
    _operationId: string,
    signal: AbortSignal,
  ): Promise<ForgeLifecycleReceipt | null> {
    const current = await this.snapshot(number, signal);
    const matches =
      action.kind === "edit"
        ? metadataMatches(current, action.changes)
        : action.kind === "close"
          ? current.state === "closed"
          : action.kind === "reopen"
            ? current.state === "open" || current.state === "draft"
            : action.kind === "ready"
              ? current.state === "open"
              : action.kind === "draft"
                ? current.state === "draft"
                : action.kind === "lock"
                  ? current.conversation?.locked === true
                  : action.kind === "unlock"
                    ? current.conversation?.locked === false
                    : false;
    return matches ? { outcome: "accepted", headSha: current.headSha } : null;
  }
}
