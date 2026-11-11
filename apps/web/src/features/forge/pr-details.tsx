import type { ReactNode } from "react";
import type { ForgeClosingIssue } from "@ace/protocol";
import { prUrl } from "@ace/forge/pr-reference";
import { Button } from "@/components/ui/button.tsx";
import { WebLink } from "@/components/web-link.tsx";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import type { PrDialog } from "./pr-dialogs.tsx";
import { lockReasonLabels } from "@ace/ui-core";

/**
 * One group of the sidebar: "Reviewers", "Labels", "Milestone"… as a quiet heading with its
 * action at the right and what it holds under it; groups are set apart by space alone.
 */
export function DetailRow(props: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="pb-5 text-ui last:pb-0">
      <div className="flex h-6 items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {props.label}
        </h4>
        {/* The action's words, not its box, end on the column's edge. */}
        {props.action && (
          <div className="-mr-1.5 flex shrink-0 items-center [&_button]:text-subtle-foreground [&_button:hover]:text-foreground">
            {props.action}
          </div>
        )}
      </div>
      <div className="mt-0.5 flex min-w-0 flex-col gap-0.5">{props.children}</div>
    </div>
  );
}

function IssueLine(props: { issue: ForgeClosingIssue; action?: ReactNode }) {
  const { issue } = props;
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2">
      <WebLink
        href={issue.url}
        className="flex min-w-0 items-center gap-1.5 rounded-xs text-foreground focus-ring hover:underline"
      >
        <span className="shrink-0 text-subtle-foreground tabular-nums">#{issue.ref.number}</span>
        <span className="truncate">{issue.title}</span>
      </WebLink>
      {issue.state === "closed" && (
        <span className="shrink-0 text-xs text-subtle-foreground">Closed</span>
      )}
      {props.action && <span className="-mr-1.5 ml-auto shrink-0">{props.action}</span>}
    </div>
  );
}

/**
 * The Summary's sidebar, as GitHub's: who reviews it, who is assigned, its labels and the agent on
 * it (`people`), then the milestone, the issues it closes (Development), a locked conversation
 * and the head branch once it is done. Each block shows only when it holds something or this
 * account can change it.
 */
export function PrDetails(props: {
  actions: PrActions;
  onDialog(dialog: PrDialog): void;
  people?: ReactNode;
}) {
  const { lifecycle } = props.actions;
  const snapshot = lifecycle.snapshot;
  if (!snapshot)
    return props.people ? (
      <aside id="pr-about" aria-label="About">
        {props.people}
      </aside>
    ) : null;
  const busy = lifecycle.blocked;
  const editMilestone = snapshot.editableFields.includes("milestone");
  const issues = snapshot.closingIssues ?? [];
  const conversation = snapshot.conversation;
  const branch = snapshot.headBranch;
  const done = snapshot.state === "merged" || snapshot.state === "closed";
  const rows: ReactNode[] = [];
  if (snapshot.milestone !== undefined && (snapshot.milestone || editMilestone))
    rows.push(
      <DetailRow
        key="milestone"
        label="Milestone"
        action={
          editMilestone && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => props.onDialog("edit")}
            >
              {snapshot.milestone ? "Change" : "Set milestone"}
            </Button>
          )
        }
      >
        {snapshot.milestone ? (
          <span className="block truncate leading-7">
            {snapshot.milestone.title}
            {snapshot.milestone.state === "closed" && (
              <span className="text-subtle-foreground"> · Closed</span>
            )}
            {snapshot.milestone.dueOn && (
              <span className="text-subtle-foreground">
                {` · due ${new Date(snapshot.milestone.dueOn).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`}
              </span>
            )}
          </span>
        ) : (
          <span className="flex h-7 items-center text-subtle-foreground">None</span>
        )}
      </DetailRow>,
    );
  if (issues.length || lifecycle.can("issue.link"))
    rows.push(
      <DetailRow
        key="issues"
        label="Linked issues"
        action={
          lifecycle.can("issue.link") && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => props.onDialog("link-issue")}
            >
              Link
            </Button>
          )
        }
      >
        {issues.map((issue) => (
          <IssueLine
            key={`${issue.ref.repository.owner}/${issue.ref.repository.name}#${issue.ref.number}`}
            issue={issue}
            action={
              issue.manual &&
              lifecycle.can("issue.unlink") && (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void lifecycle.apply({ kind: "issue.unlink", issue: issue.ref })}
                >
                  Unlink
                </Button>
              )
            }
          />
        ))}
        {!issues.length && (
          <span className="flex h-7 items-center text-subtle-foreground">None</span>
        )}
      </DetailRow>,
    );
  if (conversation?.locked)
    rows.push(
      <DetailRow
        key="conversation"
        label="Conversation"
        action={
          lifecycle.can("unlock") && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => void lifecycle.apply({ kind: "unlock" })}
            >
              Unlock
            </Button>
          )
        }
      >
        <span className="block truncate leading-7">
          {conversation.reason
            ? `Locked as ${lockReasonLabels[conversation.reason].toLowerCase()}`
            : "Locked"}
          {!conversation.viewerCanComment && (
            <span className="text-subtle-foreground"> · only collaborators can comment</span>
          )}
        </span>
      </DetailRow>,
    );
  if (
    done &&
    branch?.sameRepository &&
    (lifecycle.can("branch.delete") ||
      lifecycle.can("branch.restore") ||
      !branch.exists ||
      !!branch.usedBy?.length)
  )
    rows.push(
      <DetailRow
        key="branch"
        label="Branch"
        action={
          lifecycle.can("branch.delete") ? (
            <Button
              variant="ghost"
              size="xs"
              tone="danger"
              disabled={busy}
              onClick={() => props.onDialog("delete-branch")}
            >
              Delete branch
            </Button>
          ) : (
            lifecycle.can("branch.restore") && (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => void lifecycle.apply({ kind: "branch.restore" })}
              >
                Restore branch
              </Button>
            )
          )
        }
      >
        <span className="flex h-7 min-w-0 items-center gap-2">
          <span
            className={cn(
              "truncate font-mono text-xs",
              branch.exists ? "text-foreground/85" : "text-subtle-foreground line-through",
            )}
          >
            {branch.name}
          </span>
          {!branch.exists && (
            <span className="shrink-0 text-xs text-subtle-foreground">Deleted</span>
          )}
          {branch.exists && !!branch.usedBy?.length && (
            // Deleting it would close these, so it stays while they are open.
            <span className="flex min-w-0 items-center gap-1 text-xs text-subtle-foreground">
              Used by
              {branch.usedBy.map((number) => (
                <WebLink
                  key={number}
                  href={prUrl({ repository: snapshot.pr.repository, number })}
                  className="rounded-xs text-muted-foreground tabular-nums focus-ring hover:underline"
                >
                  #{number}
                </WebLink>
              ))}
            </span>
          )}
        </span>
      </DetailRow>,
    );
  if (!rows.length && !props.people) return null;
  return (
    <aside id="pr-about" aria-label="About">
      {props.people}
      {rows}
    </aside>
  );
}
