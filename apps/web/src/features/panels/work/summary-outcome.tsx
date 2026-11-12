import { useAgent, useItem } from "@ace/client-react";
import type { ForgePrDetail, LinkedPullRequest, TurnSummary } from "@ace/protocol";
import {
  checkLabels,
  checkOutcome,
  pluralCount,
  type ChangesByAgent,
  type CheckRun,
} from "@ace/ui-core";
import { CheckIcon, GitPullRequestIcon, XIcon } from "@phosphor-icons/react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { prDetailKey, usePrPrefetch } from "@/lib/forge-pr-detail.ts";
import { pullRequestTab, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useAgentIdentity } from "../agents/agent-identity.ts";
import { FileRow } from "./file-row.tsx";
import { PrUnlinkDialog } from "./pr-unlink-dialog.tsx";
import { useUnlinkPr } from "./pr-unlink.ts";
import { prStateWords } from "./summary-prs.tsx";

/** How many changed files show before the rest fold into "N more". */
const shownFiles = 5;

const ciWords = {
  none: "",
  pending: "Checks running",
  success: "Checks passed",
  failure: "Checks failed",
  unknown: "",
} as const;

/** One small pill of the state line, in a status colour when it carries one. */
function Pill(props: {
  tone?: "done" | "failed" | "working" | undefined;
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <li
      data-tone={props.tone}
      title={props.title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-xs tabular-nums",
        props.tone ? "text-(--tone-text)" : "text-muted-foreground",
      )}
    >
      {props.children}
    </li>
  );
}

/** One check as a pill: "✓ Tests", "✕ Typecheck", "Tests running". */
function CheckPill(props: { threadId: string; check: CheckRun }) {
  const item = useItem(props.threadId, props.check.itemId);
  const outcome = checkOutcome(
    props.check,
    item?.type === "tool_call" ? item.call.status : undefined,
  );
  const label = checkLabels[props.check.kind];
  const exit =
    outcome === "failed" && typeof props.check.exitCode === "number"
      ? `, exit ${props.check.exitCode}`
      : "";
  const title = `${props.check.command}${exit}`;
  if (outcome === "passed")
    return (
      <Pill tone="done" title={title}>
        <CheckIcon aria-hidden size={11} weight="bold" />
        {label}
        <span className="sr-only"> passed</span>
      </Pill>
    );
  if (outcome === "failed")
    return (
      <Pill tone="failed" title={title}>
        <XIcon aria-hidden size={11} weight="bold" />
        {label}
        <span className="sr-only"> failed{exit}</span>
      </Pill>
    );
  return (
    <Pill tone={outcome === "running" ? "working" : undefined} title={title}>
      {label} {outcome}
    </Pill>
  );
}

/** An agent by the name its tree row uses. */
function AgentName(props: { threadId: string; agentId: string; fallback?: string | undefined }) {
  const agent = useAgent(props.threadId, props.agentId);
  const { name } = useAgentIdentity(props.threadId, agent);
  return <>{agent ? name : (props.fallback ?? "An agent")}</>;
}

/** Two agents changing one file in the same checkout, in the warning colour. */
function Conflicts(props: {
  threadId: string;
  changes: ChangesByAgent;
  names: ReadonlyMap<string, string>;
}) {
  return props.changes.conflicts.map((conflict) => (
    <p
      key={`${conflict.worktree}:${conflict.path}`}
      role="alert"
      data-tone="needs-you"
      className="text-xs text-(--tone-text)"
    >
      <span className="font-mono">{conflict.path}</span> was changed by{" "}
      {conflict.agents.flatMap((id, index) => [
        index === 0 ? "" : index === conflict.agents.length - 1 ? " and " : ", ",
        <AgentName
          key={id}
          threadId={props.threadId}
          agentId={id}
          fallback={props.names.get(id)}
        />,
      ])}{" "}
      in the same checkout
    </p>
  ));
}

/** The latest turn's changed files, at most five, then "N more" that opens the rest in place. */
function Files(props: { threadId: string; files: TurnSummary["digest"]["files"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? props.files : props.files.slice(0, shownFiles);
  const more = props.files.length - shown.length;
  return (
    <div className="-mx-2">
      <ul aria-label="Files changed">
        {shown.map((file) => (
          <FileRow
            key={file.path}
            threadId={props.threadId}
            path={file.path}
            added={file.added}
            removed={file.removed}
          />
        ))}
      </ul>
      {more > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="focus-ring-inset h-7 rounded-sm px-2 text-xs text-subtle-foreground hover:text-foreground"
        >
          {more} more
        </button>
      )}
    </div>
  );
}

/**
 * What the thread made, first: its leading pull request on a rounded panel (title, then its
 * number and state and each latest check as pills, the changed files, Review changes and Open),
 * or without one the changed files under "N files changed". With neither, only its checks;
 * with nothing at all, nothing.
 */
export function Outcome(props: {
  threadId: string;
  workspaceId: string;
  pr: LinkedPullRequest | undefined;
  turn: TurnSummary | undefined;
  changes: ChangesByAgent;
  names: ReadonlyMap<string, string>;
  checks: readonly CheckRun[];
}) {
  const { pr, turn } = props;
  const actions = useWorkspaceActions(props.threadId);
  const prefetch = usePrPrefetch(props.workspaceId);
  const unlinkPr = useUnlinkPr(props.threadId);
  const [unlinking, setUnlinking] = useState(false);
  const detail = useQuery<ForgePrDetail>({
    queryKey: pr ? prDetailKey(props.workspaceId, pr.repo, pr.number) : ["no-pr"],
    // Read from the cache only: the PR panel reads the forge, the Summary never does.
    queryFn: skipToken,
    enabled: pr !== undefined,
  }).data;
  const files = turn?.digest.files ?? [];
  const failed = turn?.digest.commandsFailed ?? 0;
  const otherFailures = Math.max(0, failed - props.checks.filter((check) => check.failed).length);
  if (!pr && !files.length && !props.checks.length && !otherFailures) return null;
  const count =
    turn?.digest.truncated && files.length >= 64 ? "64+ files" : pluralCount(files.length, "file");
  const title = pr ? (pr.title ?? `#${pr.number}`) : files.length ? `${count} changed` : undefined;
  // An untitled pull request is named by its number once: the title, not the pill, says it.
  const stateWords = pr ? prStateWords[pr.state] : "";
  const statePill = pr ? (pr.title ? `#${pr.number} · ${stateWords}` : stateWords) : "";
  const ci = pr && detail && !props.checks.length ? ciWords[detail.status.ci] : "";
  const open = pr
    ? () =>
        actions.open(
          pullRequestTab({
            workspaceId: props.workspaceId,
            repository: pr.repo,
            number: pr.number,
          }),
        )
    : undefined;
  return (
    <section
      aria-label={pr ? `Pull request #${pr.number}` : "Changes"}
      className="group/pr flex min-w-0 flex-col gap-2 rounded-lg bg-surface-1 p-3"
    >
      {title && (
        <div className="flex min-w-0 items-start gap-2">
          {pr && (
            <GitPullRequestIcon
              aria-hidden
              size={14}
              className="mt-[3px] shrink-0 text-muted-foreground"
            />
          )}
          <h3 className="min-w-0 flex-1 text-md font-semibold [overflow-wrap:anywhere]">{title}</h3>
          {pr && (
            <IconButton
              icon={XIcon}
              label={`Unlink pull request #${pr.number}`}
              size="sm"
              onClick={() => setUnlinking(true)}
              className="-my-1 hidden group-focus-within/pr:inline-grid group-hover/pr:inline-grid pointer-coarse:inline-grid"
            />
          )}
        </div>
      )}
      {(statePill || props.checks.length > 0 || ci || otherFailures > 0) && (
        <ul aria-label="State" className="flex min-w-0 flex-wrap items-center gap-1.5">
          {statePill && <Pill>{statePill}</Pill>}
          {props.checks.map((check) => (
            <CheckPill key={check.kind} threadId={props.threadId} check={check} />
          ))}
          {ci && <Pill tone={detail?.status.ci === "failure" ? "failed" : undefined}>{ci}</Pill>}
          {otherFailures > 0 && (
            <Pill tone="failed">
              {otherFailures} {otherFailures === 1 ? "command" : "commands"} failed
            </Pill>
          )}
        </ul>
      )}
      {files.length > 0 && <Files threadId={props.threadId} files={files} />}
      <Conflicts threadId={props.threadId} changes={props.changes} names={props.names} />
      {(files.length > 0 || open) && (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {files.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => actions.open({ kind: "changes", data: { scope: "last" } })}
            >
              Review changes
            </Button>
          )}
          {pr && open && (
            <Button
              size="sm"
              variant="ghost"
              onPointerEnter={() => prefetch(pr.repo, pr.number)}
              onFocus={() => prefetch(pr.repo, pr.number)}
              onClick={open}
            >
              Open #{pr.number}
            </Button>
          )}
        </div>
      )}
      {pr && unlinking && (
        <PrUnlinkDialog
          number={pr.number}
          onClose={() => setUnlinking(false)}
          onUnlink={() => unlinkPr({ number: pr.number, repo: pr.repo })}
        />
      )}
    </section>
  );
}
