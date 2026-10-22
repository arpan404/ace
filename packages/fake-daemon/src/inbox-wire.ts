import {
  CommandId,
  type CommandPayload,
  type CommandResult,
  type ForgeBrowserResult,
  type ForgeInboxRow,
  type WorkspaceActionRequest,
} from "@ace/protocol";
import { projectRepository } from "./forge-list-wire.ts";

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
  private pollSeconds = 60;
  /** GitHub answers Mark all read with 202 and applies it later; held here until applied. */
  private deferred: (() => void)[] | undefined;
  /** How many inbox reads clients made, as GitHub would count them. */
  reads = 0;
  /** Every write the inbox received, in order. */
  readonly writes: CommandPayload[] = [];
  seed(rows: readonly ForgeInboxRow[]): void {
    this.rows = [...rows];
  }
  /** Writes after this succeed, come back unconfirmed, or are refused by GitHub. */
  setOutcome(outcome: "succeeded" | "uncertain" | "refused"): void {
    this.outcome = outcome;
  }
  /** Mark all read is accepted at once but applied only when `applyDeferred` runs, as on GitHub. */
  deferReadAll(): void {
    this.deferred = [];
  }
  applyDeferred(): void {
    for (const apply of this.deferred ?? []) apply();
    this.deferred = undefined;
  }
  /** The poll interval GitHub asks for (`X-Poll-Interval`). */
  setPollSeconds(seconds: number): void {
    this.pollSeconds = seconds;
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
    this.reads++;
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
        projectRepository: projectRepository(op),
        items: matching.slice(start, start + perPage),
        ...(matching.length > start + perPage ? { nextPage: query.page + 1 } : {}),
        pollSeconds: this.pollSeconds,
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
      const apply = () => {
        this.rows = this.rows.map((row) =>
          Date.parse(row.updatedAt) <= before && (!repository || key(row.repository) === repository)
            ? { ...row, unread: false }
            : row,
        );
      };
      if (this.deferred) this.deferred.push(apply);
      else apply();
    }
    return { ok: true, inboxAction: { ...action, state: "succeeded" } };
  }
}
