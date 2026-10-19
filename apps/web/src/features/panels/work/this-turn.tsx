import type { TurnSummary } from "@ace/protocol";
import { digestLines, formatCount, pluralCount, turnHeadline } from "@ace/ui-core";
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
 * The latest turn at a glance: the person's message on one line, then what happened since in
 * counts ("6 files changed +210 −84 · 14 commands, 1 failed · 2 approvals"). Files and commands
 * each open their list in place: files go on to Changes, commands list failures first. Read
 * from the turn index's digest (ADR 0062), never from history.
 */
export function ThisTurn(props: { threadId: string; turn: TurnSummary }) {
  const { digest } = props.turn;
  const [open, setOpen] = useState<Open>();
  const toggle = (list: Open) => setOpen((current) => (current === list ? undefined : list));
  const lines = digestLines(digest);
  const files = digest.files.length;
  const facts: ReactNode[] = [];
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
  return (
    <div className="min-w-0">
      <p className="truncate px-2 text-ui text-foreground" title={turnHeadline(props.turn)}>
        {turnHeadline(props.turn)}
      </p>
      {facts.length > 0 && (
        <p
          className={`flex min-w-0 flex-wrap items-center gap-x-1 px-2 text-xs text-muted-foreground ${separated}`}
        >
          {facts}
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
