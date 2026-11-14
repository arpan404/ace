import { useAgent, useItem } from "@ace/client-react";
import type { LinkedPullRequest, TurnSummary } from "@ace/protocol";
import {
  checkOutcome,
  checkWords,
  digestLines,
  filesChangedWords,
  otherCommandFailures,
  pluralCount,
  type ChangesByAgent,
  type CheckRun,
} from "@ace/ui-core";
import { ListChecksIcon, NotePencilIcon, TerminalIcon } from "@phosphor-icons/react";
import { Fragment, useState } from "react";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useAgentIdentity } from "../agents/agent-identity.ts";
import { FileRow } from "./file-row.tsx";
import { PrResults, resultIcon, resultRow } from "./summary-prs.tsx";
import { QuietLink, Section } from "./summary-section.tsx";

/** An agent by the name its tree row uses. */
function AgentName(props: { threadId: string; agentId: string; fallback?: string | undefined }) {
  const agent = useAgent(props.threadId, props.agentId);
  const { name } = useAgentIdentity(props.threadId, agent);
  return <>{agent ? name : (props.fallback ?? "An agent")}</>;
}

/**
 * The turn's changed files in one row: how many and by which agents, with Review opening the
 * changes view and the count opening the list in place. Two agents changing one file in the same
 * checkout reads in the warning colour.
 */
function FilesResult(props: {
  threadId: string;
  turn: TurnSummary;
  changes: ChangesByAgent;
  names: ReadonlyMap<string, string>;
}) {
  const workspace = useWorkspaceActions(props.threadId);
  const [open, setOpen] = useState(false);
  const { digest } = props.turn;
  const lines = digestLines(digest);
  const agents = props.changes.worktrees.flatMap((worktree) => worktree.agents);
  const by = agents.length > 1 ? agents : [];
  const name = (id: string) => (
    <AgentName threadId={props.threadId} agentId={id} fallback={props.names.get(id)} />
  );
  return (
    <li className={resultRow}>
      <NotePencilIcon aria-hidden size={14} className={resultIcon} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="focus-ring-inset block rounded-sm text-left text-ui font-medium"
        >
          {filesChangedWords(digest)}
        </button>
        <p className="truncate text-xs text-subtle-foreground tabular-nums">
          {lines && `+${lines.added} −${lines.removed} · `}
          {by.length > 0 && (
            <>
              by{" "}
              {by.map((agent, index) => (
                <Fragment key={agent.agentId}>
                  {index === 0 ? "" : index === by.length - 1 ? " and " : ", "}
                  {name(agent.agentId)} (
                  {agent.truncated ? `${agent.files.length}+` : agent.files.length})
                </Fragment>
              ))}
              {" · "}
            </>
          )}
          <QuietLink
            strong
            label="Review changes"
            onClick={() => workspace.open({ kind: "changes", data: { scope: "last" } })}
          >
            Review
          </QuietLink>
        </p>
        {props.changes.conflicts.map((conflict) => (
          <p
            key={`${conflict.worktree}:${conflict.path}`}
            role="alert"
            data-tone="needs-you"
            className="text-xs text-(--tone-text)"
          >
            <span className="font-mono">{conflict.path}</span> was changed by{" "}
            {conflict.agents.flatMap((id, index) => [
              index === 0 ? "" : index === conflict.agents.length - 1 ? " and " : ", ",
              <span key={id}>{name(id)}</span>,
            ])}{" "}
            in the same checkout
          </p>
        ))}
        {open && (
          <ul aria-label="Files changed" className="-ml-2 pt-1">
            {digest.files.map((file) => (
              <FileRow
                key={file.path}
                threadId={props.threadId}
                path={file.path}
                added={file.added}
                removed={file.removed}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** One check in words: "Tests passed", "Typecheck failed · exit 2", red only when it failed. */
function CheckWords(props: { threadId: string; check: CheckRun }) {
  const item = useItem(props.threadId, props.check.itemId);
  const outcome = checkOutcome(
    props.check,
    item?.type === "tool_call" ? item.call.status : undefined,
  );
  return (
    <li
      data-tone={outcome === "failed" ? "failed" : undefined}
      className={outcome === "failed" ? "text-(--tone-text)" : undefined}
      title={props.check.command}
    >
      {checkWords(props.check, outcome)}
    </li>
  );
}

/**
 * What came out of the work: its pull requests, the files it changed and by whom, and how its
 * checks went, in words. Commands that failed outside a check say so too.
 */
export function Results(props: {
  threadId: string;
  workspaceId: string;
  prs: readonly LinkedPullRequest[];
  turn: TurnSummary | undefined;
  changes: ChangesByAgent;
  names: ReadonlyMap<string, string>;
  checks: readonly CheckRun[];
}) {
  const { turn } = props;
  const otherFailures = otherCommandFailures(turn?.digest, props.checks);
  const files = (turn?.digest.files.length ?? 0) > 0;
  if (!props.prs.length && !files && !props.checks.length && !otherFailures) return null;
  return (
    <Section name="Results">
      <ul className="min-w-0">
        <PrResults threadId={props.threadId} workspaceId={props.workspaceId} prs={props.prs} />
        {turn && files && (
          <FilesResult
            threadId={props.threadId}
            turn={turn}
            changes={props.changes}
            names={props.names}
          />
        )}
        {props.checks.length > 0 && (
          <li className={resultRow} aria-label="Checks">
            <ListChecksIcon aria-hidden size={14} className={resultIcon} />
            <ul className="flex min-w-0 flex-1 flex-wrap gap-x-1 text-ui [&>li+li]:before:mr-1 [&>li+li]:before:text-subtle-foreground [&>li+li]:before:content-['·']">
              {props.checks.map((check) => (
                <CheckWords key={check.kind} threadId={props.threadId} check={check} />
              ))}
            </ul>
          </li>
        )}
        {turn && otherFailures > 0 && (
          <li className={resultRow}>
            <TerminalIcon aria-hidden size={14} className={resultIcon} />
            <p className="min-w-0 flex-1 text-ui">
              {pluralCount(turn.digest.commandsRun, "command")} ran,{" "}
              <span data-tone="failed" className="text-(--tone-text)">
                {otherFailures} failed
              </span>
            </p>
          </li>
        )}
      </ul>
    </Section>
  );
}
