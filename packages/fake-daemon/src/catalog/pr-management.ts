import {
  ForgeLifecycleState,
  type ForgeClosingIssue,
  type ForgeLifecycleAction,
  type ForgeLifecycleSnapshot,
  type ForgeMilestone,
  type ForgeRepoPrOptions,
} from "@ace/protocol";

/*
 * The fake GitHub's PR management: milestones, issues a PR closes, locked conversations and
 * head branches, and the lifecycle writes that change them, answered as GitHub would.
 */

type Snapshot = ForgeLifecycleSnapshot;
const managed = new Set<string>([
  "lock",
  "unlock",
  "branch.delete",
  "branch.restore",
  "issue.link",
  "issue.unlink",
]);

export const catalogMilestones: ForgeMilestone[] = [
  { number: 3, title: "October polish", state: "open", dueOn: "2026-10-31T00:00:00Z" },
  { number: 4, title: "Mobile beta", state: "open", dueOn: "2026-11-20T00:00:00Z" },
  { number: 5, title: "Later", state: "open", dueOn: null },
];

export function catalogPrOptions(): ForgeRepoPrOptions {
  return {
    labels: [
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "enhancement", color: "a2eeef", description: "New feature or request" },
      { name: "web", color: "1d76db", description: "" },
      { name: "providers", color: "5319e7", description: "" },
      { name: "docs", color: "0075ca", description: "" },
    ],
    assignable: ["you", "dana", "mira", "sam"].map((login) => ({ login })),
    milestones: catalogMilestones,
    truncated: false,
  };
}

/** An issue of the PR's repository as a closing reference. */
export function closingIssue(
  repository: Snapshot["pr"]["repository"],
  number: number,
  title: string,
  manual: boolean,
): ForgeClosingIssue {
  return {
    ref: { repository, number },
    title,
    state: "open",
    url: `https://github.com/${repository.owner}/${repository.name}/issues/${number}`,
    manual,
  };
}

/** What this account may do, as GitHub decides it: the fake viewer triages but can't push. */
function capabilities(snapshot: Snapshot, canPush: boolean): Pick<Snapshot, "actions"> {
  const active = snapshot.state === "open" || snapshot.state === "draft";
  const actions = snapshot.actions.filter((kind) => !managed.has(kind));
  if (snapshot.conversation) actions.push(snapshot.conversation.locked ? "unlock" : "lock");
  const branch = snapshot.headBranch;
  if (!active && branch?.sameRepository && canPush) {
    if (branch.exists && !branch.isDefault && !(snapshot.state === "merged" && branch.deleteOnMerge))
      actions.push("branch.delete");
    if (!branch.exists) actions.push("branch.restore");
  }
  if (active) actions.push("issue.link", "issue.unlink");
  return { actions };
}

/** A snapshot with the management facts filled in, and what they allow. */
export function withManagement(
  state: ForgeLifecycleState,
  facts: {
    milestone?: ForgeMilestone | null;
    closingIssues?: ForgeClosingIssue[];
    locked?: { reason: NonNullable<Snapshot["conversation"]>["reason"]; viewerCanComment: boolean };
    canPush?: boolean;
  } = {},
): ForgeLifecycleState {
  const snapshot = state.snapshot;
  const milestone = facts.milestone ?? null;
  const next: Snapshot = {
    ...snapshot,
    metadata: { ...snapshot.metadata, milestone: milestone?.number ?? null },
    editableFields:
      snapshot.state === "merged"
        ? snapshot.editableFields
        : [...snapshot.editableFields.filter((field) => field !== "milestone"), "milestone"],
    milestone,
    conversation: facts.locked
      ? { locked: true, ...facts.locked }
      : { locked: false, reason: null, viewerCanComment: true },
    headBranch: {
      name: snapshot.headBranch?.name ?? "branch",
      exists: true,
      sameRepository: true,
      isDefault: false,
      deleteOnMerge: false,
      ...snapshot.headBranch,
    },
    closingIssues: facts.closingIssues ?? snapshot.closingIssues ?? [],
  };
  return ForgeLifecycleState.parse({
    ...state,
    snapshot: { ...next, ...capabilities(next, facts.canPush ?? true) },
  });
}

/**
 * The PR after `action`, as GitHub answers it, or a refusal code. `revision` makes the new
 * version: every accepted write changes it, as GitHub's does.
 */
export function applyManagement(
  state: ForgeLifecycleState,
  action: ForgeLifecycleAction,
  revision: number,
  /** An open issue's title by number, as GitHub has it; undefined for none. */
  issueTitle: (number: number) => string | undefined,
): ForgeLifecycleState | string {
  const snapshot = state.snapshot;
  if (action.kind !== "edit" && !snapshot.actions.includes(action.kind)) return "forge_forbidden";
  let next: Snapshot = snapshot;
  if (action.kind === "edit") {
    const { milestone, ...rest } = action.changes;
    const picked =
      milestone === undefined
        ? snapshot.milestone
        : milestone === null
          ? null
          : (catalogMilestones.find((each) => each.number === milestone) ?? null);
    if (milestone && !picked) return "forge_unprocessable";
    next = {
      ...snapshot,
      metadata: {
        ...snapshot.metadata,
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
        ...(milestone === undefined ? {} : { milestone }),
      },
      milestone: picked,
    };
  } else if (action.kind === "lock" || action.kind === "unlock") {
    const locked = action.kind === "lock";
    next = {
      ...snapshot,
      conversation: {
        locked,
        reason: action.kind === "lock" ? action.reason : null,
        viewerCanComment: snapshot.conversation?.viewerCanComment ?? true,
      },
    };
  } else if (action.kind === "branch.delete" || action.kind === "branch.restore") {
    if (!snapshot.headBranch) return "forge_unsupported";
    next = {
      ...snapshot,
      headBranch: { ...snapshot.headBranch, exists: action.kind === "branch.restore" },
    };
  } else if (action.kind === "issue.link") {
    const issues = snapshot.closingIssues ?? [];
    if (issues.some((issue) => issue.ref.number === action.issue)) return "forge_conflict";
    const title = issueTitle(action.issue);
    if (title === undefined) return "forge_not_found";
    next = {
      ...snapshot,
      closingIssues: [...issues, closingIssue(snapshot.pr.repository, action.issue, title, true)],
    };
  } else if (action.kind === "issue.unlink") {
    const issues = snapshot.closingIssues ?? [];
    const linked = issues.find((issue) => issue.ref.number === action.issue.number);
    if (!linked?.manual) return "forge_forbidden";
    next = { ...snapshot, closingIssues: issues.filter((issue) => issue !== linked) };
  } else return "forge_unsupported";
  next = { ...next, version: revision.toString(16).padStart(64, "c") };
  return ForgeLifecycleState.parse({ ...state, snapshot: { ...next, ...capabilities(next, true) } });
}
