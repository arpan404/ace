import type { ForgeLifecycleSnapshot, ForgeLifecycleAction } from "@ace/protocol/forge-lifecycle";
import { ForgeError } from "./errors.ts";
export const lifecycleMutations = {
  ready: "markPullRequestReadyForReview",
  draft: "convertPullRequestToDraft",
  close: "closePullRequest",
  reopen: "reopenPullRequest",
  "update.merge": "updatePullRequestBranch",
  "update.rebase": "updatePullRequestBranch",
  revert: "revertPullRequest",
  "issue.link": "addCloseIssueReferences",
  "issue.unlink": "removeCloseIssueReferences",
};
/** Repository roles that may triage: label, set milestones, lock conversations. */
export const triageRoles = ["TRIAGE", "WRITE", "MAINTAIN", "ADMIN"];
/** Repository roles that may push, and still comment on a locked conversation. */
export const writeRoles = ["WRITE", "MAINTAIN", "ADMIN"];
/** Facts about the head branch and lock that only newer hosts report. */
export interface LifecycleExtraFacts {
  locked: boolean;
  headExists: boolean;
  sameRepository: boolean;
  isDefault: boolean;
  deleteOnMerge: boolean;
  canRestoreHead: boolean;
  /** Other open PRs whose head is this branch. */
  openPrsOnHead: readonly number[];
}
/** One capability/state gate serves daemon writes and the public workspace snapshot. */
export function lifecycleCapabilities(facts: {
  state: ForgeLifecycleSnapshot["state"];
  archived: boolean;
  canUpdate: boolean;
  canLabel: boolean;
  canAssign: boolean;
  canClose: boolean;
  canReopen: boolean;
  canUpdateBranch: boolean;
  rebaseable: boolean;
  canRevert: boolean;
  supported: ReadonlySet<string>;
  /** The viewer's repository role, as GitHub names it. */
  permission?: string | null;
  extras?: LifecycleExtraFacts | undefined;
}): Pick<ForgeLifecycleSnapshot, "actions" | "editableFields" | "unsupported"> {
  const actions: ForgeLifecycleSnapshot["actions"] = [];
  const editableFields: ForgeLifecycleSnapshot["editableFields"] = [];
  const unsupported: ForgeLifecycleSnapshot["unsupported"] = (
    Object.keys(lifecycleMutations) as (keyof typeof lifecycleMutations)[]
  ).filter((kind) => !facts.supported.has(lifecycleMutations[kind]));
  if (facts.archived) return { actions, editableFields, unsupported };
  if (facts.supported.has("updatePullRequest")) {
    if (facts.canUpdate) {
      editableFields.push("title", "body");
      if (facts.state === "open" || facts.state === "draft") editableFields.push("baseBranch");
    }
    if (facts.canLabel) editableFields.push("labels");
    if (facts.canAssign) editableFields.push("assignees");
  }
  const extras = facts.extras;
  const triage = triageRoles.includes(facts.permission ?? "");
  const active = facts.state === "open" || facts.state === "draft";
  // A milestone is set through the issue it shares its number with, by anyone who triages.
  if (extras && triage) editableFields.push("milestone");
  if (facts.state === "draft" && facts.canUpdate) actions.push("ready");
  if (facts.state === "open" && facts.canUpdate) actions.push("draft");
  if ((facts.state === "open" || facts.state === "draft") && facts.canClose) actions.push("close");
  if (facts.state === "closed" && facts.canReopen) actions.push("reopen");
  if ((facts.state === "open" || facts.state === "draft") && facts.canUpdateBranch) {
    actions.push("update.merge");
    if (facts.rebaseable) actions.push("update.rebase");
  }
  if (facts.state === "merged" && facts.canRevert) actions.push("revert");
  if (extras && triage) actions.push(extras.locked ? "unlock" : "lock");
  if (extras && !active && extras.sameRepository && extras.canRestoreHead) {
    // GitHub deletes a merged PR's branch itself when the repository asks it to: never race it.
    const githubDeletes = facts.state === "merged" && extras.deleteOnMerge;
    // Another open PR from the same branch would close with it.
    const shared = extras.openPrsOnHead.length > 0;
    if (extras.headExists && !extras.isDefault && !githubDeletes && !shared)
      actions.push("branch.delete");
    if (!extras.headExists) actions.push("branch.restore");
  }
  if (extras && active && facts.canUpdate) actions.push("issue.link", "issue.unlink");
  return {
    actions: actions.filter((kind) => !unsupported.includes(kind)),
    editableFields,
    unsupported,
  };
}
export function assertLifecycleAction(
  snapshot: ForgeLifecycleSnapshot,
  expectedVersion: string,
  action: ForgeLifecycleAction,
): void {
  if (snapshot.version !== expectedVersion) throw new ForgeError("conflict");
  if (action.kind === "edit") {
    const fields = Object.keys(action.changes);
    if (!fields.length) throw new ForgeError("invalid_data");
    if (fields.some((field) => !snapshot.editableFields.some((editable) => editable === field)))
      throw new ForgeError("forbidden");
  } else {
    if (snapshot.unsupported.includes(action.kind)) throw new ForgeError("unsupported");
    if (!snapshot.actions.includes(action.kind)) throw new ForgeError("forbidden");
  }
}
export function metadataMatches(
  snapshot: ForgeLifecycleSnapshot,
  changes: Extract<ForgeLifecycleAction, { kind: "edit" }>["changes"],
): boolean {
  return Object.entries(changes).every(([key, value]) => {
    const actual = snapshot.metadata[key as keyof typeof changes];
    if (key === "assignees" && Array.isArray(value) && Array.isArray(actual)) {
      const expected = new Set(value.map((login) => login.toLowerCase()));
      const observed = new Set(actual.map((login) => login.toLowerCase()));
      return expected.size === observed.size && [...expected].every((login) => observed.has(login));
    }
    return Array.isArray(value) && Array.isArray(actual)
      ? JSON.stringify(value.toSorted()) === JSON.stringify(actual.toSorted())
      : actual === value;
  });
}
