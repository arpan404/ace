import {
  CommandId,
  type CommandPayload,
  type CommandResult,
  type ForgeBrowserResult,
  type ForgeInboxRow,
  type WorkspaceActionRequest,
} from "@ace/protocol";

/** Reasons GitHub counts as taking part in a thread. */
const participating = new Set([
  "review_requested",
  "mention",
  "team_mention",
  "author",
  "comment",
  "assign",
  "state_change",
]);
const perPage = 50;
const key = (repository: ForgeInboxRow["repository"]) =>
  `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();

/**
 * GitHub notifications through the production read and command contracts: unread or all,
 * participating, one repository, pages of 50. Writes change them as GitHub does: read clears the
 * dot, done removes the thread, read-all clears every dot up to its time.
 */
export class FakeInboxWire {
  private rows: ForgeInboxRow[] = [];
  private unsubscribed = new Set<string>();
  private outcome: "succeeded" | "uncertain" | "refused" = "succeeded";
  private unavailable = false;
  /** Every write the inbox received, in order. */
  readonly writes: CommandPayload[] = [];
  seed(rows: readonly ForgeInboxRow[]): void {
    this.rows = [...rows];
  }
  /** Writes after this succeed, come back unconfirmed, or are refused by GitHub. */
  setOutcome(outcome: "succeeded" | "uncertain" | "refused"): void {
    this.outcome = outcome;
  }
  /** gh's token can't read notifications (a fine-grained token). */
  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }
  /** Threads the person unsubscribed from. */
  unsubscribedFrom(): string[] {
    return [...this.unsubscribed];
  }
  read(
    op: WorkspaceActionRequest["operation"],
  ): ForgeBrowserResult | { error: string } | undefined {
    if (op.op !== "forge.inbox.list") return undefined;
    if (this.unavailable) return { error: "forge_notifications_unavailable" };
    const { query } = op;
    const repository = query.repository ? key(query.repository) : undefined;
    const since = query.since ? Date.parse(query.since) : undefined;
    const matching = this.rows.filter(
      (row) =>
        (query.all || row.unread) &&
        (!query.participating || participating.has(row.reason)) &&
        (!repository || key(row.repository) === repository) &&
        (since === undefined || Date.parse(row.updatedAt) >= since),
    );
    const start = (query.page - 1) * perPage;
    return {
      resource: "inboxList",
      value: {
        host: op.host ?? "github.com",
        items: matching.slice(start, start + perPage),
        ...(matching.length > start + perPage ? { nextPage: query.page + 1 } : {}),
        pollSeconds: 60,
        unchanged: false,
      },
    };
  }
  command(payload: CommandPayload, id: string): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type !== "forge.inbox.write") return undefined;
    this.writes.push(payload);
    const input = payload.input;
    const action = { id: CommandId.parse(id), action: input.action };
    if (this.outcome === "refused")
      return {
        ok: false,
        error: "forge_notifications_unavailable",
        inboxAction: { ...action, state: "failed", error: "forge_notifications_unavailable" },
      };
    if (this.outcome === "uncertain")
      return {
        ok: false,
        error: "action_outcome_uncertain",
        inboxAction: { ...action, state: "uncertain", error: "forge_outcome_uncertain" },
      };
    if (input.action === "read")
      this.rows = this.rows.map((row) => (row.id === input.id ? { ...row, unread: false } : row));
    else if (input.action === "done") this.rows = this.rows.filter((row) => row.id !== input.id);
    else if (input.action === "unsubscribe") this.unsubscribed.add(input.id);
    else {
      const before = Date.parse(input.before);
      const repository = input.repository ? key(input.repository) : undefined;
      this.rows = this.rows.map((row) =>
        Date.parse(row.updatedAt) <= before && (!repository || key(row.repository) === repository)
          ? { ...row, unread: false }
          : row,
      );
    }
    return { ok: true, inboxAction: { ...action, state: "succeeded" } };
  }
}
