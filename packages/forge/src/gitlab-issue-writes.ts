import type { ForgeIssueDetail, ForgeIssueWrite } from "@ace/protocol/forge-issues";
import { ForgeError } from "./errors.ts";
import { applyMembers, planIssueWrite } from "./issue-write-plan.ts";
import type { HostApiWrite } from "./read-only-api.ts";

/**
 * Every GitLab issue write ace sends (ADR 0117), each as
 * `glab api <endpoint> -X <METHOD> --hostname <host> --include --input -`:
 *
 * - `POST projects/:id/issues`: create an issue;
 * - `POST projects/:id/issues/:iid/notes`: comment on one;
 * - `PUT projects/:id/issues/:iid`: edit its title, description, labels, assignees or milestone,
 *   or close or reopen it (`state_event`).
 *
 * `:id` is the URL-encoded project path. Nothing else is admitted: no merge request endpoints,
 * no deletes, no query strings.
 */
export const gitlabIssueWrites: readonly HostApiWrite[] = [
  { method: "POST", endpoint: /^projects\/[^/?#]+\/issues$/ },
  { method: "POST", endpoint: /^projects\/[^/?#]+\/issues\/[1-9]\d*\/notes$/ },
  { method: "PUT", endpoint: /^projects\/[^/?#]+\/issues\/[1-9]\d*$/ },
];

type Change = Exclude<ForgeIssueWrite, { action: "create" } | { action: "comment" }>;

/** What one write to an existing GitLab issue sends, decided against the issue as read now. */
export type GitLabIssuePlan =
  | { kind: "done" }
  | { kind: "conflict" }
  | { kind: "forbidden" }
  | { kind: "put"; body: Record<string, unknown> }
  /** GitLab sets assignees whole, by user id: these usernames, in this order. */
  | { kind: "assign"; usernames: string[] };

/**
 * A change as GitLab can express it. GitLab records no reason an issue closed, so closing as
 * completed is plain closing, and closing as not planned is refused rather than misreported.
 */
export function gitlabIssueChange<T extends ForgeIssueWrite>(value: T): T {
  if (value.action !== "state" || value.reason === undefined) return value;
  if (value.reason !== "completed") throw new ForgeError("unsupported");
  const { reason: _completed, ...plain } = value;
  return plain as T;
}

export function planGitLabIssueWrite(current: ForgeIssueDetail, value: Change): GitLabIssuePlan {
  const plan = planIssueWrite(current, gitlabIssueChange(value));
  if (plan.kind === "done" || plan.kind === "conflict" || plan.kind === "forbidden") return plan;
  if (plan.kind === "members") {
    if (plan.field === "assignees")
      return { kind: "assign", usernames: applyMembers(current.assignees, plan.add, plan.remove) };
    // GitLab's label fields are comma-separated, so a name with a comma can't be sent safely.
    if ([...plan.add, ...plan.remove].some((name) => name.includes(",")))
      throw new ForgeError("unsupported");
    // Added and removed by name in one request, so labels someone else set meanwhile stay.
    return {
      kind: "put",
      body: {
        ...(plan.add.length ? { add_labels: plan.add.join(",") } : {}),
        ...(plan.remove.length ? { remove_labels: plan.remove.join(",") } : {}),
      },
    };
  }
  switch (value.action) {
    case "state":
      return { kind: "put", body: { state_event: value.state === "open" ? "reopen" : "close" } };
    case "milestone":
      // 0 clears the milestone.
      return { kind: "put", body: { milestone_id: value.milestone ?? 0 } };
    default: {
      const { body: description, ...rest } = plan.body;
      return {
        kind: "put",
        body: { ...rest, ...(description === undefined ? {} : { description }) },
      };
    }
  }
}
