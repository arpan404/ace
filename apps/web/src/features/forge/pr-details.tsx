import type { ReactNode } from "react";
import type { ForgeClosingIssue } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { WebLink } from "@/components/web-link.tsx";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import type { PrDialog } from "./pr-dialogs.tsx";
import { PrSection } from "./pr-section.tsx";
import { lockReasonLabels } from "./pr-lock-reasons.ts";

function Row(props: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-start gap-3 py-0.5 text-ui">
      <span className="flex h-7 w-24 shrink-0 items-center text-xs text-muted-foreground">
        {props.label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{props.children}</div>
      {/* The action's words, not its box, end on the column's edge. */}
      {props.action && <div className="-mr-1.5 flex h-7 shrink-0 items-center">{props.action}</div>}
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
 * What the pull request is filed under and what it touches on GitHub besides its code: the
 * milestone, the issues it closes, a locked conversation and the head branch once it is done.
 * Each row shows only when it holds something or this account can change it.
 */
export function PrDetails(props: { actions: PrActions; onDialog(dialog: PrDialog): void }) {
  const { lifecycle } = props.actions;
  const snapshot = lifecycle.snapshot;
  if (!snapshot) return null;
  const busy = lifecycle.blocked;
  const editMilestone = snapshot.editableFields.includes("milestone");
  const issues = snapshot.closingIssues ?? [];
  const conversation = snapshot.conversation;
  const branch = snapshot.headBranch;
  const done = snapshot.state === "merged" || snapshot.state === "closed";
  const rows: ReactNode[] = [];
  if (snapshot.milestone !== undefined && (snapshot.milestone || editMilestone))
    rows.push(
      <Row
        key="milestone"
        label="Milestone"
        action={
          editMilestone && (
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => props.onDialog("edit")}>
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
      </Row>,
    );
  if (issues.length || lifecycle.can("issue.link"))
    rows.push(
      <Row key="issues" label="Closes">
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
        {lifecycle.can("issue.link") ? (
          <span className="flex h-7 items-center">
            {/* The words, not the box, start on the column's edge. */}
            <Button
              variant="ghost"
              size="xs"
              className="-ml-1.5 text-muted-foreground"
              disabled={busy}
              onClick={() => props.onDialog("link-issue")}
            >
              Link an issue
            </Button>
          </span>
        ) : (
          !issues.length && <span className="flex h-7 items-center text-subtle-foreground">None</span>
        )}
      </Row>,
    );
  if (conversation?.locked)
    rows.push(
      <Row
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
          {conversation.reason ? `Locked as ${lockReasonLabels[conversation.reason].toLowerCase()}` : "Locked"}
          {!conversation.viewerCanComment && (
            <span className="text-subtle-foreground"> · only collaborators can comment</span>
          )}
        </span>
      </Row>,
    );
  if (done && branch?.sameRepository && (lifecycle.can("branch.delete") || lifecycle.can("branch.restore") || !branch.exists))
    rows.push(
      <Row
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
          {!branch.exists && <span className="shrink-0 text-xs text-subtle-foreground">Deleted</span>}
        </span>
      </Row>,
    );
  if (!rows.length) return null;
  return (
    <PrSection title="Details" fixed>
      <div>{rows}</div>
    </PrSection>
  );
}
