import type { LinkedPullRequest, TurnSummary } from "@ace/protocol";
import { digestLines, formatCount, pluralCount } from "@ace/ui-core";
import { useState, type ReactNode } from "react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { cn } from "@/lib/cn.ts";
import { CapsuleGlyph } from "../agents/task-capsule.tsx";
import { FileRow } from "./file-row.tsx";

type Open = "files" | "commands" | undefined;

/** A middle dot between neighbouring facts, drawn rather than read. */
export const separated =
  "[&>*+*]:before:mr-1 [&>*+*]:before:text-subtle-foreground [&>*+*]:before:content-['·']";

/**
 * What the latest turn achieved, in counts ("2 PRs merged · 6 files changed +210 −84 · 14
 * commands, 1 failed"), then the agent's latest words. Not the person's message echoed back:
 * the transcript already shows it. Files and commands each open their list in place: files go
 * on to Changes, commands list failures first. Read from the turn index's digest (ADR 0062) and
 * the thread's linked pull requests, never from history.
 */
export function ThisTurn(props: {
  threadId: string;
  turn: TurnSummary;
  prs: readonly LinkedPullRequest[];
}) {
  const { digest } = props.turn;
  const [open, setOpen] = useState<Open>();
  const toggle = (list: Open) => setOpen((current) => (current === list ? undefined : list));
  const lines = digestLines(digest);
  const files = digest.files.length;
  const facts: ReactNode[] = [];
  // Pull requests that moved since the turn began: merged in it, or up for review.
  const recent = props.prs.filter((pr) => pr.updatedAt >= props.turn.startedAt);
  const merged = recent.filter((pr) => pr.state === "merged").length;
  const opened = recent.filter((pr) => pr.state === "open" || pr.state === "draft").length;
  if (merged)
    facts.push(
      <span key="merged" className="tabular-nums">
        {pluralCount(merged, "PR")} merged
      </span>,
    );
  if (opened)
    facts.push(
      <span key="opened" className="tabular-nums">
        {pluralCount(opened, "PR")} in review
      </span>,
    );
  if (files)
    facts.push(
      <Fact key="files" open={open === "files"} onClick={() => toggle("files")}>
        {digest.truncated && files >= 64 ? "64+ files" : pluralCount(files, "file")} changed
        {lines && <DiffStat additions={lines.added} deletions={lines.removed} className="ml-1.5" />}
      </Fact>,
    );
  if (digest.commandsRun)
    facts.push(
      <Fact
        key="commands"
        open={open === "commands"}
        onClick={digest.commands.length ? () => toggle("commands") : undefined}
      >
        {pluralCount(digest.commandsRun, "command")}
        {digest.commandsFailed > 0 && (
          <span data-tone="failed" className="text-(--tone-text)">
            , {formatCount(digest.commandsFailed)} failed
          </span>
        )}
      </Fact>,
    );
  if (digest.approvalsAsked)
    facts.push(
      <span key="approvals" className="tabular-nums">
        {pluralCount(digest.approvalsAsked, "approval")}
      </span>,
    );
  const commands = digest.commands.toSorted(
    (left, right) => Number(right.failed) - Number(left.failed),
  );
  const said = props.turn.latestAgentMessagePreview.replace(/\s+/g, " ").trim();
  return (
    <div className="min-w-0">
      {facts.length > 0 && (
        <p
          className={`flex min-h-6 min-w-0 flex-wrap items-center gap-x-1 px-2 text-ui text-foreground ${separated}`}
        >
          {facts}
        </p>
      )}
      {said && (
        <p className="truncate px-2 text-xs text-muted-foreground" title={said}>
          {said}
        </p>
      )}
      {open === "files" && (
        <ul aria-label="Files changed" className="mt-1">
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
      {open === "commands" && (
        <ul aria-label="Commands" className="mt-1">
          {commands.map((command) => (
            <li
              key={command.itemId}
              aria-label={`${command.command}: ${command.failed ? "failed" : "ran"}`}
              className="flex h-7 min-w-0 items-center gap-2 px-2 text-xs"
            >
              <CapsuleGlyph state={command.failed ? "failed" : "done"} />
              <span className="min-w-0 flex-1 truncate font-mono" title={command.command}>
                {command.command}
              </span>
              {command.failed && typeof command.exitCode === "number" && (
                <span className="shrink-0 text-subtle-foreground tabular-nums">
                  exit {command.exitCode}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A count that opens its list, or plain words when there is no list to open. */
function Fact(props: { open: boolean; onClick?: (() => void) | undefined; children: ReactNode }) {
  if (!props.onClick) return <span className="tabular-nums">{props.children}</span>;
  return (
    <button
      type="button"
      aria-expanded={props.open}
      onClick={props.onClick}
      className={cn(
        "focus-ring inline-flex items-center rounded-sm tabular-nums hover:text-foreground",
        props.open && "text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}
