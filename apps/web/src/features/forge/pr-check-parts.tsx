import type { ReactNode } from "react";
import type {
  ForgeCheck,
  ForgeCheckAnnotation,
  ForgeCheckRun,
  ForgeCheckStep,
} from "@ace/protocol";
import { fileAnnotation, formatAgo } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { PrMarkdown } from "./pr-markdown.tsx";
import { TextAction } from "./pr-text-action.tsx";
import { CheckDisc, type DiscTone } from "./pr-check-disc.tsx";
import { checkDuration, checkState } from "./pr-checks-list.tsx";

/** "Failed after 2m 14s · just now", "Running for 4m 2s": the head's line under the name. */
export function checkLine(check: ForgeCheck, now: number): string {
  const { word } = checkState(check);
  const took = checkDuration(check, now);
  const ran = took
    ? check.status === "pending"
      ? `${word} for ${took}`
      : `${word} after ${took}`
    : word;
  const ended = check.completedAt ? Date.parse(check.completedAt) : NaN;
  return Number.isFinite(ended) ? `${ran} · ${formatAgo(ended, now)}` : ran;
}

/** The detail box's head: a larger disc, the check's name, its line, its actions at the right. */
export function CheckDetailHead(props: {
  tone: DiscTone;
  name: string;
  line: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border px-4 py-3.5">
      <CheckDisc tone={props.tone} large />
      <div className="min-w-40 flex-1">
        <h3 className="text-ui font-semibold break-words text-foreground">{props.name}</h3>
        <p className="text-ui text-muted-foreground">{props.line}</p>
      </div>
      {props.actions && <div className="flex flex-wrap items-center gap-1.5">{props.actions}</div>}
    </div>
  );
}

const levelLook: Record<ForgeCheckAnnotation["level"], { tone?: string; word: string }> = {
  failure: { tone: "failed", word: "Error" },
  warning: { tone: "needs-you", word: "Warning" },
  notice: { word: "Notice" },
};

/** Each annotation in a box tinted by its level: file:line in mono, the message, Show in code. */
export function Annotations(props: {
  annotations: readonly ForgeCheckAnnotation[];
  truncated: boolean;
  onOpenCode(path: string): void;
}) {
  if (!props.annotations.length) return null;
  return (
    <ul aria-label="Annotations" className="space-y-2">
      {props.annotations.map((annotation) => {
        const look = levelLook[annotation.level];
        const where = `${annotation.path}${annotation.startLine ? `:${annotation.startLine}` : ""}`;
        return (
          <li
            key={`${where}:${annotation.level}:${annotation.title}:${annotation.message}`}
            data-tone={look.tone}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-ui",
              look.tone ? "border-(--tone)/25 bg-(--tone)/6" : "border-border bg-surface-1",
            )}
          >
            <p
              className={cn(
                "font-mono text-xs break-all",
                look.tone ? "text-(--tone-text)" : "text-muted-foreground",
              )}
            >
              <span className="sr-only">{`${look.word}: `}</span>
              {where}
            </p>
            {annotation.title && (
              <p className="mt-0.5 break-words text-xs text-subtle-foreground">
                {annotation.title}
              </p>
            )}
            <p className="mt-0.5 break-words whitespace-pre-wrap text-foreground">
              {annotation.message}
            </p>
            {fileAnnotation(annotation.path) && (
              <div className="mt-1.5">
                <TextAction
                  strong
                  aria-label={`Open ${where} in Code`}
                  onClick={() => props.onOpenCode(annotation.path)}
                >
                  Show in code
                </TextAction>
              </div>
            )}
          </li>
        );
      })}
      {props.truncated && (
        <li className="text-xs text-subtle-foreground">More annotations are on GitHub.</li>
      )}
    </ul>
  );
}

const stepTone: Record<ForgeCheckStep["status"], DiscTone> = {
  success: "done",
  failure: "failed",
  pending: "working",
  cancelled: "idle",
  skipped: "off",
  unknown: "off",
};

/** The job's steps; picking one brings its first log line to the top of the log. */
export function Steps(props: { steps: readonly ForgeCheckStep[]; onJump(line: number): void }) {
  const shown = props.steps.filter((step) => step.status !== "skipped");
  if (shown.length < 2) return null;
  return (
    <ol aria-label="Steps">
      {shown.map((step) => {
        const line = step.line;
        return (
          <li key={step.number} className="border-t border-border-soft first:border-t-0">
            <button
              type="button"
              disabled={line === null}
              onClick={() => line !== null && props.onJump(line)}
              className="flex min-h-8 w-full items-center gap-2.5 rounded-sm py-1.5 text-left text-ui text-foreground transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover disabled:hover:bg-transparent"
            >
              <CheckDisc tone={stepTone[step.status]} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  step.status === "failure" && "font-semibold",
                )}
              >
                {step.name}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** What the check's app said: all an external check has in place of a log. */
export function Output(props: {
  run: ForgeCheckRun;
  context: PrWorkspaceContext;
  onOpen(number: number): void;
}) {
  const { title, summary, text } = props.run.output;
  if (!title && !summary && !text) return null;
  return (
    <div className="space-y-1">
      {title && <p className="text-ui font-medium text-foreground">{title}</p>}
      {summary && <PrMarkdown text={summary} context={props.context} onOpen={props.onOpen} />}
      {text && <PrMarkdown text={text} context={props.context} onOpen={props.onOpen} />}
    </div>
  );
}
