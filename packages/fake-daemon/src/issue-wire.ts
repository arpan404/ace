import {
  ForgeIssueDetail,
  type ForgeIssueAction,
  type ForgeBrowserResult,
  type CommandPayload,
  type CommandResult,
  CommandId,
  WorkspaceActionRequest,
} from "@ace/protocol";

/** Hosted issue fixtures change through the production command/read contracts. */
export class FakeIssueWire {
  private reads: Map<string, ForgeBrowserResult>;
  private journal = new Map<string, { scope: string; number: number; result: ForgeIssueAction }>();
  private outcome: "succeeded" | "uncertain" | "unsent" = "succeeded";
  private now: () => number;
  constructor(reads: Map<string, ForgeBrowserResult>, now: () => number) {
    this.reads = reads;
    this.now = now;
  }
  setOutcome(outcome: "succeeded" | "uncertain" | "unsent"): void {
    this.outcome = outcome;
  }
  read(op: WorkspaceActionRequest["operation"]): ForgeBrowserResult | undefined {
    if (op.op !== "forge.issue.actions") return undefined;
    const scope = JSON.stringify([op.workspaceId, op.repository]);
    const entries = [...this.journal.values()].filter((entry) => entry.scope === scope);
    return entries.length
      ? {
          resource: "issueActions",
          actions: entries
            .filter((entry) => entry.number === op.number)
            .map((entry) => entry.result),
        }
      : undefined;
  }
  command(payload: CommandPayload, id: string): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type !== "forge.issue.write" && payload.type !== "forge.issue.reconcile")
      return undefined;
    if (payload.type === "forge.issue.reconcile") {
      const entry = this.journal.get(payload.actionId);
      if (!entry?.result.issue) return { ok: false, error: "action_outcome_uncertain" };
      entry.result = { ...entry.result, state: "succeeded" };
      return { ok: true, issue: entry.result.issue, issueAction: entry.result };
    }
    const scope = JSON.stringify([payload.workspaceId, payload.repository]);
    const input = payload.input;
    const number = input.action === "create" ? 0 : input.number;
    const unsent = (error: string): Omit<CommandResult, "commandId"> => ({
      ok: false,
      error,
      code: "action_not_dispatched",
      issueAction: { id: CommandId.parse(id), action: input.action, state: "failed", error },
    });
    if (this.outcome === "unsent") return unsent("forge_write_pending");
    if (
      [...this.journal.values()].some(
        (entry) =>
          entry.scope === scope &&
          entry.number === number &&
          (entry.result.state === "pending" || entry.result.state === "uncertain"),
      )
    )
      return unsent("issue_reconciliation_required");
    let detail: ForgeIssueDetail | undefined;
    for (const value of this.reads.values())
      if (
        value.resource === "issueDetail" &&
        JSON.stringify(value.value.ref.repository) === JSON.stringify(payload.repository) &&
        value.value.ref.number === number
      )
        detail = value.value;
    if (
      input.action !== "create" &&
      (!detail ||
        (input.action === "edit" && !detail.permissions.edit) ||
        (input.action === "comment" && !detail.permissions.comment) ||
        (input.action === "state" &&
          !(input.state === "closed" ? detail.permissions.close : detail.permissions.reopen)))
    )
      return unsent("forge_forbidden");
    if (
      detail &&
      (input.action === "edit" || input.action === "state") &&
      detail.updatedAt !== input.expectedUpdatedAt
    ) {
      const result: ForgeIssueAction = {
        id: CommandId.parse(id),
        action: input.action,
        state: "failed",
        error: "forge_conflict",
      };
      this.journal.set(id, { scope, number, result });
      return { ok: false, error: "forge_conflict", issueAction: result };
    }
    const at = new Date(this.now()).toISOString();
    if (input.action === "create") {
      const maximum = Math.max(
        0,
        ...[...this.reads.values()].flatMap((value) =>
          value.resource === "issueList" ? value.value.items.map((issue) => issue.ref.number) : [],
        ),
      );
      detail = ForgeIssueDetail.parse({
        ref: { repository: payload.repository, number: maximum + 1 },
        title: input.title,
        body: input.body,
        url: `https://${payload.repository.host}/${payload.repository.owner}/${payload.repository.name}/issues/${maximum + 1}`,
        author: "author",
        state: "open",
        labels: [],
        assignees: [],
        milestone: null,
        createdAt: at,
        updatedAt: at,
        permissions: {
          edit: true,
          comment: true,
          close: true,
          reopen: true,
          reason: "Fixture permissions",
        },
        relatedThreads: [],
        relatedThreadsTruncated: false,
      });
    } else if (detail) {
      detail = {
        ...detail,
        updatedAt: at,
        ...(input.action === "edit" ? { title: input.title, body: input.body } : {}),
        ...(input.action === "state" ? { state: input.state } : {}),
      };
    }
    if (!detail) return { ok: false, error: "forge_not_found" };
    const published = detail;
    let known = false;
    for (const [key, value] of this.reads) {
      const request = WorkspaceActionRequest.safeParse({
        type: "workspace.request",
        requestId: "fixture",
        operation: JSON.parse(key),
      });
      if (
        !request.success ||
        !("workspaceId" in request.data.operation) ||
        request.data.operation.workspaceId !== payload.workspaceId
      )
        continue;
      if (
        value.resource === "issueDetail" &&
        JSON.stringify(value.value.ref) === JSON.stringify(published.ref)
      ) {
        this.reads.set(key, { resource: "issueDetail", value: published });
        known = true;
      }
      if (
        value.resource === "issueList" &&
        JSON.stringify(value.value.repository) === JSON.stringify(payload.repository) &&
        request.data.operation.op === "forge.issue.list"
      ) {
        const list = value.value;
        const existing = list.items.find((issue) => issue.ref.number === published.ref.number);
        const matches = request.data.operation.query.state === published.state;
        const items = list.items.flatMap((issue) =>
          issue.ref.number === published.ref.number ? (matches ? [published] : []) : [issue],
        );
        const counts = { ...list.counts };
        if (existing && existing.state !== published.state) {
          counts[existing.state]--;
          counts[published.state]++;
        }
        if (input.action === "create") {
          counts.open++;
          if (matches) items.unshift(published);
        }
        this.reads.set(key, {
          resource: "issueList",
          value: {
            ...list,
            items: items.slice(0, 25),
            total: list.total + items.length - list.items.length,
            counts,
          },
        });
      }
      if (
        input.action === "comment" &&
        value.resource === "issueTimeline" &&
        request.data.operation.op === "forge.issue.timeline" &&
        request.data.operation.number === published.ref.number
      )
        this.reads.set(key, {
          ...value,
          events: [
            ...value.events,
            {
              id,
              kind: "issue_comment",
              event: "commented",
              actor: "author",
              body: input.body,
              at,
              raw: {},
            },
          ],
        });
    }
    if (!known)
      for (const repository of [undefined, payload.repository])
        this.reads.set(
          JSON.stringify({
            op: "forge.issue.detail",
            workspaceId: payload.workspaceId,
            repository,
            number: published.ref.number,
          }),
          { resource: "issueDetail", value: published },
        );
    const result: ForgeIssueAction = {
      id: CommandId.parse(id),
      action: input.action,
      state: this.outcome,
      issue: published.ref,
    };
    this.journal.set(id, { scope, number, result });
    return this.outcome === "succeeded"
      ? { ok: true, issue: published.ref, issueAction: result }
      : {
          ok: false,
          error: "action_outcome_uncertain",
          issueAction: { ...result, issue: undefined },
        };
  }
}
