import type {
  CommandPayload,
  CommandResult,
  ForgeBrowserResult,
  WorkspaceActionRequest,
} from "@ace/protocol";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";
import { catalogGroupCounts, catalogPrList } from "./forge-list-wire.ts";
import { colors } from "./forge-list-rows.ts";
import { applyHostedReview } from "./pr-review-actions.ts";

/**
 * Whole pull requests the fake app can open in its PR panel: detail, merge state, lifecycle,
 * review state, files and activity, answered for any project that asks about them. Reads a
 * test set explicitly (`setForgeRead`) still win.
 */
export class FakePrCatalog {
  private fixtures: PullRequestFixture[] = [];
  private readonly now: () => number;
  constructor(now: () => number = () => 0) {
    this.now = now;
  }
  seed(fixtures: readonly PullRequestFixture[]): void {
    // As GitHub answers: each label with its colour.
    this.fixtures = fixtures.map((fixture) => ({
      ...fixture,
      detail: {
        ...fixture.detail,
        labelColors: fixture.detail.labelColors ?? colors(fixture.detail.labels),
      },
    }));
  }
  private find(op: { repository?: unknown; number?: unknown }) {
    return this.fixtures.find(
      (fixture) =>
        fixture.detail.status.ref.number === op.number &&
        (op.repository === undefined ||
          JSON.stringify(op.repository) === JSON.stringify(fixture.detail.status.ref.repository)),
    );
  }
  /**
   * `forge.hosted.merge` on a catalog PR, as GitHub answers it: the head must be the one the
   * person saw, and a closed, conflicting or failing PR is refused. A merge marks it merged in
   * every read, the list included.
   */
  merge(payload: CommandPayload): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type !== "forge.hosted.merge") return undefined;
    const fixture = this.find(payload.pr);
    if (!fixture) return { ok: false, error: "forge_not_found" };
    const { status } = fixture.detail;
    if (status.headSha !== payload.headSha || status.state !== "open")
      return { ok: false, error: "forge_conflict" };
    if (status.mergeability === "conflicting" || status.ci === "failure")
      return { ok: false, error: "forge_write_refused" };
    return { ok: true, pr: payload.pr, prStatus: this.markMerged(fixture).detail.status };
  }
  /** A catalog PR as merged, as a merge from anywhere (Verify's included) leaves it. */
  mergeNumber(number: number): void {
    const fixture = this.fixtures.find((entry) => entry.detail.status.ref.number === number);
    if (fixture?.detail.status.state === "open") this.markMerged(fixture);
  }
  private markMerged(fixture: PullRequestFixture): PullRequestFixture {
    const { status } = fixture.detail;
    const merged: PullRequestFixture = {
      ...fixture,
      detail: { ...fixture.detail, status: { ...status, state: "merged" } },
      ...(fixture.mergeState
        ? { mergeState: { ...fixture.mergeState, state: "MERGED", mergeState: "UNKNOWN" } }
        : {}),
      lifecycle: {
        ...fixture.lifecycle,
        snapshot: { ...fixture.lifecycle.snapshot, state: "merged", actions: ["revert"] },
      },
    };
    this.fixtures = this.fixtures.map((entry) => (entry === fixture ? merged : entry));
    return merged;
  }
  /**
   * `forge.hosted.merge-state` on a catalog PR: auto-merge on where GitHub allows it (as "you",
   * the signed-in account) and off again, pinned to the head the person saw.
   */
  mergeState(payload: CommandPayload): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type !== "forge.hosted.merge-state") return undefined;
    const fixture = this.find(payload.pr);
    const state = fixture?.mergeState;
    if (!fixture || !state) return { ok: false, error: "forge_not_found" };
    if (state.headSha !== payload.headSha) return { ok: false, error: "forge_conflict" };
    if (payload.action === "enable" ? !state.canEnable : !state.canDisable)
      return { ok: false, error: "forge_forbidden" };
    const next = {
      ...state,
      autoMerge:
        payload.action === "enable"
          ? {
              method: payload.method.toUpperCase(),
              actor: "you",
              enabledAt: new Date(0).toISOString(),
            }
          : null,
      canEnable: payload.action === "disable",
      canDisable: payload.action === "enable",
    };
    this.fixtures = this.fixtures.map((entry) =>
      entry === fixture ? { ...fixture, mergeState: next } : entry,
    );
    return { ok: true, pr: payload.pr, prStatus: { ...fixture.detail.status, mergeState: next } };
  }
  /**
   * `forge.hosted.review` on a catalog PR: drafts, comments, replies, hiding, resolving and
   * viewed marks change it in memory, so the next detail and review-state reads show them.
   */
  review(payload: CommandPayload, commandId: string): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type !== "forge.hosted.review") return undefined;
    const fixture = this.find(payload.pr);
    if (!fixture) return undefined;
    const applied = applyHostedReview(
      fixture,
      payload.action,
      commandId,
      new Date(this.now()).toISOString(),
    );
    this.fixtures = this.fixtures.map((entry) => (entry === fixture ? applied.fixture : entry));
    return applied.result;
  }
  /** Each list group's total, from these pull requests and the issues in `reads`. */
  groupCounts(
    op: WorkspaceActionRequest["operation"],
    reads: ReadonlyMap<string, ForgeBrowserResult>,
  ): ForgeBrowserResult | undefined {
    return op.op === "forge.group-counts"
      ? catalogGroupCounts(op, this.fixtures, reads)
      : undefined;
  }
  read(op: WorkspaceActionRequest["operation"]): ForgeBrowserResult | undefined {
    if (op.op === "forge.pr.list") return catalogPrList(op, this.fixtures);
    if (op.op === "forge.pr.stack-memberships") {
      const known = op.numbers.filter((number) => this.find({ ...op, number }));
      return known.length === op.numbers.length
        ? {
            resource: "prStackMemberships",
            value: op.numbers.map((number) => ({ number, stack: null })),
          }
        : undefined;
    }
    if (!("number" in op)) return undefined;
    const fixture = this.find(op);
    if (!fixture) return undefined;
    switch (op.op) {
      case "forge.pr.detail":
        return { resource: "prDetail", value: fixture.detail };
      case "forge.pr.merge-state":
        return fixture.mergeState
          ? { resource: "prMergeState", value: fixture.mergeState }
          : undefined;
      case "forge.pr.lifecycle":
        return { resource: "prLifecycle", value: fixture.lifecycle };
      case "forge.pr.review-state":
        return { resource: "prReviewState", value: fixture.review };
      case "forge.pr.files":
        return {
          resource: "prFiles",
          value: {
            ref: fixture.detail.status.ref,
            baseSha: fixture.detail.baseSha,
            headSha: fixture.detail.status.headSha,
            files: fixture.files,
            truncated: false,
          },
        };
      case "forge.pr.activity":
        return { resource: "prActivity", events: fixture.activity, truncated: false };
      case "forge.pr.commits":
        return { resource: "prCommits", commits: [], truncated: false };
      default:
        return undefined;
    }
  }
}
