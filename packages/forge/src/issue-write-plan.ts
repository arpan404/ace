import type { ForgeIssueDetail, ForgeIssueWrite } from "@ace/protocol/forge-issues";

type Change = Exclude<ForgeIssueWrite, { action: "create" } | { action: "comment" }>;

/**
 * What a write to an existing issue does, decided against the issue as GitHub has it now:
 * nothing (it already says so), a refusal, or the one PATCH to send. Activity on a busy issue
 * (comments, labels, other fields) never blocks a write; only a field someone else changed to
 * something else since the edit began does.
 */
export type IssueWritePlan =
  | { kind: "done" }
  | { kind: "conflict" }
  | { kind: "forbidden" }
  | { kind: "patch"; body: Record<string, unknown> }
  /**
   * Labels or assignees change by their own add and remove calls, never by sending the whole
   * set: a set sent whole would erase what someone else added since it was read.
   */
  | { kind: "members"; field: "labels" | "assignees"; add: string[]; remove: string[] };

/** Names compare case-insensitively, as hosts compare logins and labels; the first spelling stays. */
const unique = (values: readonly string[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/** The set after adding and removing, keeping what it had in its own order. */
export function applyMembers(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
) {
  const lower = new Set(remove.map((value) => value.toLowerCase()));
  return unique([...current, ...add]).filter((value) => !lower.has(value.toLowerCase()));
}

/** Only what changes: names not there yet to add, names there (as GitHub spells them) to remove. */
function members(
  field: "labels" | "assignees",
  current: readonly string[],
  value: { add: readonly string[]; remove: readonly string[] },
  allowed: boolean | undefined,
): IssueWritePlan {
  const next = applyMembers(current, value.add, value.remove);
  if (same(next, current)) return { kind: "done" };
  if (!allowed) return { kind: "forbidden" };
  const kept = new Set(next.map((name) => name.toLowerCase()));
  const had = new Set(current.map((name) => name.toLowerCase()));
  return {
    kind: "members",
    field,
    add: next.filter((name) => !had.has(name.toLowerCase())),
    remove: current.filter((name) => !kept.has(name.toLowerCase())),
  };
}

function edit(current: ForgeIssueDetail, value: Extract<Change, { action: "edit" }>) {
  if (current.title === value.title && current.body === value.body)
    return { kind: "done" } as const;
  if (!value.base)
    return current.updatedAt === value.expectedUpdatedAt
      ? ({ kind: "patch", body: { title: value.title, body: value.body } } as const)
      : ({ kind: "conflict" } as const);
  const body: Record<string, unknown> = {};
  for (const field of ["title", "body"] as const) {
    if (value[field] === value.base[field] || value[field] === current[field]) continue;
    // Someone else changed this same field to something else after the edit began.
    if (current[field] !== value.base[field]) return { kind: "conflict" } as const;
    body[field] = value[field];
  }
  return Object.keys(body).length
    ? ({ kind: "patch", body } as const)
    : ({ kind: "done" } as const);
}

export function planIssueWrite(current: ForgeIssueDetail, value: Change): IssueWritePlan {
  const can = current.permissions;
  const triage = can.triage ?? can.edit;
  switch (value.action) {
    case "edit": {
      const plan = edit(current, value);
      return plan.kind === "patch" && !can.edit ? { kind: "forbidden" } : plan;
    }
    case "state": {
      const reason = value.state === "closed" ? (value.reason ?? "completed") : "reopened";
      if (current.state === value.state && (value.state === "open" || !value.reason))
        return { kind: "done" };
      if (current.state === value.state && current.stateReason === reason) return { kind: "done" };
      // A closed issue's reason changes as an edit; closing and reopening have their own rights.
      const allowed =
        value.state === "open" ? can.reopen : current.state === "open" ? can.close : can.edit;
      if (!allowed) return { kind: "forbidden" };
      return { kind: "patch", body: { state: value.state, state_reason: reason } };
    }
    case "labels":
      return members("labels", current.labels, value, triage);
    case "assignees":
      return members("assignees", current.assignees, value, triage);
    case "milestone":
      if ((current.milestoneNumber ?? null) === value.milestone) return { kind: "done" };
      return triage
        ? { kind: "patch", body: { milestone: value.milestone } }
        : { kind: "forbidden" };
  }
}

/** Whether the issue as read now shows a change already made: for recovery after a lost answer. */
export function issueWriteLanded(current: ForgeIssueDetail, value: Change): boolean {
  switch (value.action) {
    case "edit": {
      // With a base, only the fields this edit changed were sent: the others may hold someone
      // else's newer text, which says nothing about whether this edit landed.
      const changed = (["title", "body"] as const).filter(
        (field) => !value.base || value[field] !== value.base[field],
      );
      return changed.every((field) => current[field] === value[field]);
    }
    case "state":
      return (
        current.state === value.state &&
        (value.state === "open" || !value.reason || current.stateReason === value.reason)
      );
    case "labels":
    case "assignees": {
      const have = new Set(
        (value.action === "labels" ? current.labels : current.assignees).map((name) =>
          name.toLowerCase(),
        ),
      );
      return (
        value.add.every((name) => have.has(name.toLowerCase())) &&
        value.remove.every((name) => !have.has(name.toLowerCase()))
      );
    }
    case "milestone":
      return (current.milestoneNumber ?? null) === value.milestone;
  }
}
