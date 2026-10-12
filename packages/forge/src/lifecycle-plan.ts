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
};
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
}): Pick<ForgeLifecycleSnapshot, "actions" | "editableFields" | "unsupported"> {
  const actions: ForgeLifecycleSnapshot["actions"] = [];
  const editableFields: ForgeLifecycleSnapshot["editableFields"] = [];
  const unsupported = (
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
  if (facts.state === "draft" && facts.canUpdate) actions.push("ready");
  if (facts.state === "open" && facts.canUpdate) actions.push("draft");
  if ((facts.state === "open" || facts.state === "draft") && facts.canClose) actions.push("close");
  if (facts.state === "closed" && facts.canReopen) actions.push("reopen");
  if ((facts.state === "open" || facts.state === "draft") && facts.canUpdateBranch) {
    actions.push("update.merge");
    if (facts.rebaseable) actions.push("update.rebase");
  }
  if (facts.state === "merged" && facts.canRevert) actions.push("revert");
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
