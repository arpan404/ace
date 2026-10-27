import { commitsRead, contentRead, filesRead } from "./pr-code-reads.ts";
import type {
  CommandPayload,
  CommandResult,
  ForgeBrowserResult,
  WorkspaceActionRequest,
} from "@ace/protocol";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";
import { catalogGroupCounts, catalogPrList } from "./forge-list-wire.ts";
import { applyManagement, catalogPrOptions, withManagement } from "./catalog/pr-management.ts";
import { compareBranches, newPrContext } from "./catalog/new-pr.ts";
import { sketchPullRequests } from "./catalog/forge-browse.ts";
import { colors } from "./forge-list-rows.ts";
import { applyHostedReview } from "./pr-review-actions.ts";

/** How many lines a fake push adds at the top of each changed file. */
const pushedLines = 10;

/**
 * `patch` after a push that adds ten lines at the top of the file: they join its first change
 * as added lines, and every later change starts ten lines further down on the new side.
 */
function pushedPatch(patch: string): string {
  let first = true;
  return patch.replaceAll(
    /^@@ -(\d+(?:,\d+)?) \+(\d+)(?:,(\d+))? @@.*$/gm,
    (_header: string, left: string, start: string, count: string | undefined) => {
      if (!first) return `@@ -${left} +${Number(start) + pushedLines},${count ?? "1"} @@`;
      first = false;
      const added = Array.from({ length: pushedLines }, (_, i) => `+pushed line ${i + 1}`);
      return [`@@ -${left} +${start},${Number(count ?? "1") + pushedLines} @@`, ...added].join(
        "\n",
      );
    },
  );
}

/** A line ten further down, as a push of ten lines above it leaves it. */
const shift = (line: number | null | undefined) => (line == null ? line : line + pushedLines);
import { FakePrPeople } from "./pr-people-wire.ts";

/**
 * Whole pull requests the fake app can open in its PR panel: detail, merge state, lifecycle,
 * review state, files and activity, answered for any project that asks about them. Reads a
 * test set explicitly (`setForgeRead`) still win.
 */
export class FakePrCatalog {
  private fixtures: PullRequestFixture[] = [];
  /** Bumped by every accepted lifecycle write: GitHub's new version of the PR. */
  private revision = 0;
  /** The commit each merge wrote, as the person edited it: what GitHub would show. */
  readonly mergeCommits: { number: number; title: string; message: string }[] = [];
  private readonly now: () => number;
  constructor(now: () => number = () => 0) {
    this.now = now;
  }
  private people = new FakePrPeople();
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
    if (payload.commit && payload.method !== "rebase")
      this.mergeCommits.push({ number: payload.pr.number, ...payload.commit });
    return { ok: true, pr: payload.pr, prStatus: this.markMerged(fixture).detail.status };
  }
  /**
   * A push to a catalog PR's branch, for trying the app against a moving head: a new head, and
   * ten lines added above every change, so each new-side line number now names other code.
   * Conversations on the new side move down with their lines, as GitHub moves them; pending
   * drafts stay on the old head and so read as outdated.
   */
  push(number: number): boolean {
    const fixture = this.fixtures.find((entry) => entry.detail.status.ref.number === number);
    if (!fixture || fixture.detail.status.state !== "open") return false;
    const { status } = fixture.detail;
    const headSha = (status.headSha.slice(2) + status.headSha.slice(0, 2)).replace(/^./, "e");
    const pushed: PullRequestFixture = {
      ...fixture,
      detail: {
        ...fixture.detail,
        status: {
          ...status,
          headSha,
          reviewThreads: status.reviewThreads.map((thread) =>
            thread.side === "LEFT"
              ? thread
              : Object.assign({}, thread, {
                  line: shift(thread.line) ?? null,
                  startLine: shift(thread.startLine),
                }),
          ),
        },
      },
      ...(fixture.mergeState ? { mergeState: { ...fixture.mergeState, headSha } } : {}),
      lifecycle: { ...fixture.lifecycle, snapshot: { ...fixture.lifecycle.snapshot, headSha } },
      review: { ...fixture.review, headSha },
      files: fixture.files.map((file) =>
        file.patch === null
          ? file
          : Object.assign({}, file, {
              patch: pushedPatch(file.patch),
              additions: file.additions + pushedLines,
            }),
      ),
    };
    this.fixtures = this.fixtures.map((entry) => (entry === fixture ? pushed : entry));
    return true;
  }
  /**
   * Edits as GitHub takes them: a description edit (`forge.hosted.lifecycle`) only against the
   * version it was chosen from, and a comment edit (`forge.hosted.review`) only while the
   * comment still reads as the person last saw it. Every read shows the new text after.
   */
  edit(payload: CommandPayload): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type === "forge.hosted.lifecycle") {
      const fixture = this.find(payload.pr);
      if (!fixture) return { ok: false, error: "forge_not_found" };
      const operation = payload.operation;
      if (operation.kind !== "apply" || operation.action.kind !== "edit") return undefined;
      const { snapshot } = fixture.lifecycle;
      if (operation.expectedVersion !== snapshot.version)
        return { ok: false, error: "forge_conflict" };
      const changes = Object.fromEntries(
        Object.entries(operation.action.changes).filter(([, value]) => value !== undefined),
      );
      const metadata: typeof snapshot.metadata = { ...snapshot.metadata, ...changes };
      const version = (BigInt(`0x${snapshot.version}`) + 1n).toString(16).padStart(64, "0");
      this.replace(fixture, {
        ...fixture,
        detail: {
          ...fixture.detail,
          body: metadata.body,
          status: { ...fixture.detail.status, title: metadata.title },
          labels: metadata.labels,
        },
        lifecycle: { ...fixture.lifecycle, snapshot: { ...snapshot, metadata, version } },
      });
      return {
        ok: true,
        forgeLifecycle: { outcome: "accepted", headSha: fixture.detail.status.headSha },
      };
    }
    if (payload.type !== "forge.hosted.review" || payload.action.kind !== "comment.edit")
      return undefined;
    const fixture = this.find(payload.pr);
    if (!fixture) return { ok: false, error: "forge_not_found" };
    const action = payload.action;
    const comments = fixture.detail.status.comments;
    const comment = comments.find((entry) => entry.id === action.commentId);
    if (!comment) return { ok: false, error: "forge_not_found" };
    if (comment.body !== action.expectedBody) return { ok: false, error: "forge_conflict" };
    this.replace(fixture, {
      ...fixture,
      detail: {
        ...fixture.detail,
        status: {
          ...fixture.detail.status,
          comments: comments.with(comments.indexOf(comment), { ...comment, body: action.body }),
        },
      },
    });
    return { ok: true };
  }
  private replace(fixture: PullRequestFixture, next: PullRequestFixture): void {
    this.fixtures = this.fixtures.map((entry) => (entry === fixture ? next : entry));
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
      lifecycle: this.managed(fixture, {
        ...fixture.lifecycle,
        snapshot: { ...fixture.lifecycle.snapshot, state: "merged", actions: ["revert"] },
      }),
    };
    this.fixtures = this.fixtures.map((entry) => (entry === fixture ? merged : entry));
    return merged;
  }
  /** `state` with the PR's milestone, issues and lock carried over, and what they allow now. */
  private managed(fixture: PullRequestFixture, state: PullRequestFixture["lifecycle"]) {
    const before = fixture.lifecycle.snapshot;
    const conversation = before.conversation;
    return withManagement(state, {
      milestone: before.milestone ?? null,
      closingIssues: before.closingIssues ?? [],
      ...(conversation?.locked
        ? {
            locked: {
              reason: conversation.reason,
              viewerCanComment: conversation.viewerCanComment,
            },
          }
        : {}),
    });
  }
  /**
   * `forge.hosted.lifecycle` on a catalog PR, as GitHub answers it: a write chosen from an older
   * version is refused; an accepted one changes the PR in every later read.
   */
  lifecycle(
    payload: CommandPayload,
    issueTitle: (number: number) => string | undefined,
    now = 0,
  ): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type !== "forge.hosted.lifecycle") return undefined;
    const fixture = this.find(payload.pr);
    if (!fixture) return undefined;
    const operation = payload.operation;
    if (operation.kind !== "apply") return { ok: false, error: "forge_not_found" };
    const snapshot = fixture.lifecycle.snapshot;
    if (operation.expectedVersion !== snapshot.version)
      return { ok: false, error: "forge_conflict" };
    const action = operation.action;
    const handled =
      action.kind === "edit" ||
      ["lock", "unlock", "branch.delete", "branch.restore", "issue.link", "issue.unlink"].includes(
        action.kind,
      );
    if (!handled) return { ok: false, error: "forge_unsupported" };
    this.revision += 1;
    const next = applyManagement(fixture.lifecycle, action, this.revision, issueTitle);
    if (typeof next === "string") return { ok: false, error: next };
    const metadata = next.snapshot.metadata;
    // GitHub's timeline records each of these as an event of its own.
    const events: Record<string, string> = {
      lock: "locked",
      unlock: "unlocked",
      "branch.delete": "head_ref_deleted",
      "branch.restore": "head_ref_restored",
      "issue.link": "connected",
      "issue.unlink": "disconnected",
    };
    const milestone = action.kind === "edit" ? action.changes.milestone : undefined;
    const event =
      events[action.kind] ??
      (milestone === undefined ? undefined : milestone === null ? "demilestoned" : "milestoned");
    const subject =
      action.kind === "lock"
        ? action.reason?.replace("_", " ")
        : event === "milestoned"
          ? next.snapshot.milestone?.title
          : event === "demilestoned"
            ? snapshot.milestone?.title
            : undefined;
    const activity = event
      ? [
          ...fixture.activity,
          {
            id: `fake-${this.revision}`,
            event,
            actor: "you",
            at: new Date(now).toISOString(),
            ...(subject ? { subject } : {}),
            raw: {},
          },
        ]
      : fixture.activity;
    const updated: PullRequestFixture = {
      ...fixture,
      activity,
      detail: {
        ...fixture.detail,
        body: metadata.body,
        labels: metadata.labels,
        baseBranch: metadata.baseBranch,
        status: { ...fixture.detail.status, title: metadata.title },
      },
      lifecycle: next,
    };
    this.fixtures = this.fixtures.map((entry) => (entry === fixture ? updated : entry));
    return {
      ok: true,
      forgeLifecycle: { outcome: "accepted", headSha: fixture.detail.status.headSha },
    };
  }
  /**
   * `forge.hosted.pr.create`: a new PR in the catalog from a branch, or the open one the branch
   * already has into that base. Labels, assignees, milestone and reviewers land with it.
   */
  create(payload: CommandPayload, now: number): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type !== "forge.hosted.pr.create") return undefined;
    const existing = this.fixtures.find(
      (entry) =>
        entry.detail.headBranch === payload.head.branch &&
        entry.detail.baseBranch === payload.base &&
        (entry.detail.status.state === "open" || entry.detail.status.state === "draft"),
    );
    if (existing)
      return {
        ok: true,
        pr: existing.detail.status.ref,
        prStatus: existing.detail.status,
        prExisting: true,
      };
    const compared = compareBranches(
      now,
      payload.base,
      payload.head,
      1,
      () => undefined,
      () => undefined,
    );
    if (!compared.totalCommits) return { ok: false, error: "forge_no_commits" };
    const number =
      Math.max(240, ...this.fixtures.map((entry) => entry.detail.status.ref.number)) + 1;
    const [created] = sketchPullRequests(now, [
      {
        number,
        title: payload.title,
        state: payload.draft ? "draft" : "open",
        author: "you",
        reviewers: payload.reviewers,
        ci: "pending",
        updated: 0,
        body: payload.body,
        labels: payload.labels,
        assignees: payload.assignees,
        branch: payload.head.branch,
        files: [],
      },
    ]);
    if (!created) return { ok: false, error: "forge_invalid_data" };
    const ref = created.detail.status.ref;
    // Its changed files are the comparison's, as GitHub lists them.
    const files = compared.files;
    const fixture: PullRequestFixture = {
      ...created,
      detail: {
        ...created.detail,
        baseBranch: payload.base,
        changedFiles: compared.totalFiles,
        commits: compared.totalCommits,
      },
      files,
      lifecycle: withManagement(
        { ...created.lifecycle, snapshot: { ...created.lifecycle.snapshot, pr: ref } },
        {
          milestone:
            catalogPrOptions().milestones.find((each) => each.number === payload.milestone) ?? null,
        },
      ),
    };
    this.fixtures = [...this.fixtures, fixture];
    return { ok: true, pr: ref, prStatus: fixture.detail.status };
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
    // Reviewer requests, withdrawals and dismissals live in the people model.
    const people = this.people.review(payload, (pr) => this.find(pr));
    if (people) return people;
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
  /**
   * Another person reviews catalog PR `number` on GitHub: the PR's detail gains the review and
   * its new decision, and its reviewers read shows the review as theirs.
   */
  submitReview(
    number: number,
    review: { login: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"; at: string },
  ): void {
    const fixture = this.fixtures.find((entry) => entry.detail.status.ref.number === number);
    if (!fixture) return;
    const id = 10_000 + fixture.detail.status.comments.length;
    const decision = this.people.submit(fixture, { ...review, id });
    const { detail } = fixture;
    const next: PullRequestFixture = {
      ...fixture,
      detail: {
        ...detail,
        updatedAt: review.at,
        reviewDecision: decision,
        status: {
          ...detail.status,
          comments: [
            ...detail.status.comments,
            {
              kind: "review",
              id,
              body: "",
              author: review.login,
              file: null,
              line: null,
              createdAt: review.at,
              updatedAt: review.at,
              replyTo: null,
              reviewState: review.state,
            },
          ],
        },
      },
    };
    this.fixtures = this.fixtures.map((entry) => (entry === fixture ? next : entry));
  }
  /** `@` people, `#` references and a catalog PR's reviewers; `issues` lists the repository's. */
  peopleRead(
    op: WorkspaceActionRequest["operation"],
    issues: (state: "open" | "closed") => readonly { ref: { number: number }; title: string }[],
  ): ForgeBrowserResult | undefined {
    return this.people.read(op, this.fixtures, issues, (read) =>
      "number" in read ? this.find(read) : undefined,
    );
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
  read(op: WorkspaceActionRequest["operation"], now = 0): ForgeBrowserResult | undefined {
    if (op.op === "forge.pr.list") return catalogPrList(op, this.fixtures);
    if (op.op === "forge.repo.milestones")
      return { resource: "repoMilestones", value: catalogPrOptions().milestones };
    if (op.op === "forge.repo.pr-options")
      return { resource: "repoPrOptions", value: catalogPrOptions() };
    if (op.op === "forge.pr.new-context")
      return {
        resource: "newPrContext",
        value: newPrContext(this.fixtures.map((entry) => entry.detail.headBranch)),
      };
    if (op.op === "forge.compare") {
      const pr = (branch: string) =>
        this.fixtures.find((entry) => entry.detail.headBranch === branch);
      // The open PR these branches already have, as GitHub's head-and-base lookup finds it.
      const existing =
        op.page === 1
          ? this.fixtures.find(
              (entry) =>
                entry.detail.headBranch === op.head.branch &&
                entry.detail.baseBranch === op.base &&
                (entry.detail.status.state === "open" || entry.detail.status.state === "draft"),
            )
          : undefined;
      const compared = compareBranches(
        now,
        op.base,
        op.head,
        op.page,
        (branch) =>
          pr(branch)?.files.map(
            (each) => [each.path, each.additions, each.deletions] as [string, number, number],
          ),
        (branch) => pr(branch)?.detail.status.title,
      );
      return {
        resource: "compare",
        value: existing ? { ...compared, existingPr: existing.detail.status.ref.number } : compared,
      };
    }
    if (op.op === "forge.pr.stack-memberships") {
      const known = op.numbers.filter((number) => this.find({ ...op, number }));
      return known.length === op.numbers.length
        ? {
            resource: "prStackMemberships",
            value: op.numbers.map((number) => ({ number, stack: null })),
          }
        : undefined;
    }
    if (op.op === "forge.file.content") return contentRead(this.fixtures, op);
    if (!("number" in op)) return undefined;
    const fixture = this.find(op);
    if (!fixture) return undefined;
    switch (op.op) {
      case "forge.pr.detail":
        return {
          resource: "prDetail",
          value: { ...fixture.detail, reviewers: this.people.requestedLogins(fixture) },
        };
      case "forge.pr.merge-state":
        return fixture.mergeState
          ? {
              resource: "prMergeState",
              value: { ...fixture.mergeState, commitMessages: commitMessages(fixture) },
            }
          : undefined;
      case "forge.pr.lifecycle":
        return { resource: "prLifecycle", value: fixture.lifecycle };
      case "forge.pr.review-state":
        return { resource: "prReviewState", value: fixture.review };
      case "forge.pr.files":
        return filesRead(fixture, op);
      case "forge.pr.activity":
        return { resource: "prActivity", events: fixture.activity, truncated: false };
      case "forge.pr.commits":
        return commitsRead(fixture);
      default:
        return undefined;
    }
  }
}

/** GitHub's prefill for a catalog PR's merge and squash commits. */
function commitMessages(fixture: PullRequestFixture) {
  const { detail } = fixture;
  const number = detail.status.ref.number;
  const repository = detail.status.ref.repository;
  return {
    merge: {
      title: `Merge pull request #${number} from ${repository.owner}/${detail.headBranch}`,
      message: detail.status.title,
    },
    squash: {
      title: `${detail.status.title} (#${number})`,
      message: detail.body,
    },
  };
}
