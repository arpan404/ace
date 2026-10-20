import type { ForgeBrowserResult, WorkspaceActionRequest } from "@ace/protocol";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";

/**
 * Whole pull requests the fake app can open in its PR panel: detail, merge state, lifecycle,
 * review state, files and activity, answered for any project that asks about them. Reads a
 * test set explicitly (`setForgeRead`) still win.
 */
export class FakePrCatalog {
  private fixtures: PullRequestFixture[] = [];
  seed(fixtures: readonly PullRequestFixture[]): void {
    this.fixtures = [...fixtures];
  }
  private find(op: { repository?: unknown; number?: unknown }) {
    return this.fixtures.find(
      (fixture) =>
        fixture.detail.status.ref.number === op.number &&
        (op.repository === undefined ||
          JSON.stringify(op.repository) === JSON.stringify(fixture.detail.status.ref.repository)),
    );
  }
  read(op: WorkspaceActionRequest["operation"]): ForgeBrowserResult | undefined {
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
