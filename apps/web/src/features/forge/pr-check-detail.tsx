import { useState } from "react";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  InfoIcon,
  MinusCircleIcon,
  SparkleIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type {
  ForgeCheck,
  ForgeCheckAnnotation,
  ForgeCheckRun,
  ForgeCheckStep,
} from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { PrMarkdown } from "./pr-markdown.tsx";
import { PrCheckLog } from "./pr-check-log.tsx";
import {
  checkControls,
  checkFixRequest,
  checkLogNote,
  checkRunId,
  fileAnnotation,
} from "@ace/ui-core";
import { useCheckRerun, useCheckRun } from "./pr-check-run.ts";
import { useFixWithAgent } from "./pr-fix-with-agent.ts";
import { readFailureText } from "./query-state.tsx";

const stepLook: Record<ForgeCheckStep["status"], { icon: typeof CircleIcon; tone: string }> = {
  success: { icon: CheckCircleIcon, tone: "text-status-done" },
  failure: { icon: XCircleIcon, tone: "text-status-failed" },
  pending: { icon: ClockIcon, tone: "text-status-working" },
  cancelled: { icon: MinusCircleIcon, tone: "text-subtle-foreground" },
  skipped: { icon: MinusCircleIcon, tone: "text-faint-foreground" },
  unknown: { icon: CircleIcon, tone: "text-subtle-foreground" },
};
const levelLook: Record<
  ForgeCheckAnnotation["level"],
  { icon: typeof CircleIcon; tone: string; word: string }
> = {
  failure: { icon: XCircleIcon, tone: "text-status-failed", word: "Error" },
  warning: { icon: WarningIcon, tone: "text-status-needs-you", word: "Warning" },
  notice: { icon: InfoIcon, tone: "text-subtle-foreground", word: "Notice" },
};

function Annotations(props: {
  annotations: readonly ForgeCheckAnnotation[];
  truncated: boolean;
  onOpenCode(path: string): void;
}) {
  if (!props.annotations.length) return null;
  return (
    <ul aria-label="Annotations" className="space-y-1">
      {props.annotations.map((annotation) => {
        const look = levelLook[annotation.level];
        const Glyph = look.icon;
        const where = `${annotation.path}${annotation.startLine ? `:${annotation.startLine}` : ""}`;
        return (
          <li
            key={`${where}:${annotation.level}:${annotation.title}:${annotation.message}`}
            className="flex items-start gap-2 text-ui"
          >
            <Glyph aria-label={look.word} size={14} className={cn("mt-0.5 shrink-0", look.tone)} />
            <div className="min-w-0 flex-1">
              {fileAnnotation(annotation.path) && (
                <button
                  type="button"
                  onClick={() => props.onOpenCode(annotation.path)}
                  aria-label={`Open ${where} in Code`}
                  className="max-w-full truncate rounded-xs font-mono text-xs text-muted-foreground hover:text-foreground focus-ring"
                >
                  {where}
                </button>
              )}
              {annotation.title && (
                <p className="break-words text-xs text-subtle-foreground">{annotation.title}</p>
              )}
              <p className="break-words whitespace-pre-wrap text-foreground">
                {annotation.message}
              </p>
            </div>
          </li>
        );
      })}
      {props.truncated && (
        <li className="text-xs text-subtle-foreground">More annotations are on GitHub.</li>
      )}
    </ul>
  );
}

function Steps(props: { steps: readonly ForgeCheckStep[]; onJump(line: number): void }) {
  const shown = props.steps.filter((step) => step.status !== "skipped");
  if (shown.length < 2) return null;
  return (
    <ol aria-label="Steps" className="space-y-px">
      {shown.map((step) => {
        const look = stepLook[step.status];
        const Glyph = look.icon;
        const line = step.line;
        return (
          <li key={step.number}>
            <button
              type="button"
              disabled={line === null}
              onClick={() => line !== null && props.onJump(line)}
              className="flex min-h-6 w-full items-center gap-2 rounded-sm px-1 text-left text-xs text-muted-foreground transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover hover:text-foreground disabled:hover:bg-transparent"
            >
              <Glyph aria-hidden size={12} className={cn("shrink-0", look.tone)} />
              <span className="min-w-0 flex-1 truncate">{step.name}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** What the check's app said: all an external check has in place of a log. */
function Output(props: {
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

/**
 * One check opened in place: its re-runs and "Fix with agent", its annotations, and its log
 * opened at the failing step, or for another app's check what that app reported. GitHub is
 * linked only when ace has nothing of the check to show.
 */
export function PrCheckDetail(props: {
  context: PrWorkspaceContext;
  check: ForgeCheck;
  hostThreadId?: string | undefined;
  onOpen(number: number): void;
  onOpenCode(path: string): void;
}) {
  const { context, check } = props;
  const { detail, workspaceId } = context;
  const pr = detail.status.ref;
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const query = useCheckRun({ workspaceId, pr, check, enabled: true });
  const rerun = useCheckRerun({ workspaceId, pr, onDone: context.refresh });
  const agent = useFixWithAgent({ workspaceId, detail, hostThreadId: props.hostThreadId });
  const [jump, setJump] = useState<{ line: number; seq: number }>();
  const url = check.url;
  const openOnGitHub = url && (
    <Button
      variant="ghost"
      size="xs"
      onClick={(event) =>
        void openWeb(url, event).catch(() => toast.error({ title: "Couldn't open the check" }))
      }
    >
      <ArrowSquareOutIcon aria-hidden size={12} />
      Open on GitHub
    </Button>
  );
  if (checkRunId(check) === undefined)
    return (
      <div className="py-1 pl-6">
        {openOnGitHub || (
          <p className="text-ui text-muted-foreground">
            GitHub reports nothing more for this check.
          </p>
        )}
      </div>
    );
  if (query.isPending)
    return (
      <div role="status" aria-label={`Reading ${check.name}`} className="py-1 pl-6">
        <SkeletonText lines={4} />
      </div>
    );
  if (query.isError)
    return (
      <p
        role="alert"
        className="flex flex-wrap items-center gap-2 py-1 pl-6 text-ui text-muted-foreground"
      >
        {`Couldn't read this check. ${readFailureText(query.error)}`}
        <Button size="xs" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </p>
    );
  const run = query.data;
  const open = detail.status.state === "open" || detail.status.state === "draft";
  const controls = checkControls(check, run, open);
  const workflow = run.workflow;
  const reason = context.disabled ? "Wait for GitHub to refresh" : undefined;
  const blank =
    !run.log &&
    !run.annotations.length &&
    !run.output.title &&
    !run.output.summary &&
    !run.output.text;
  const note = checkLogNote(check, run);
  return (
    <div className="space-y-2 py-1 pl-6">
      <div className="flex flex-wrap items-center gap-1.5">
        {workflow && controls.rerunFailed && (
          <DisabledReason reason={reason}>
            <Button
              size="xs"
              disabled={rerun.pending || context.disabled}
              onClick={() =>
                void rerun.run({
                  kind: "rerun",
                  runId: workflow.runId,
                  attempt: workflow.attempt,
                  jobs: "failed",
                })
              }
            >
              Re-run failed jobs
            </Button>
          </DisabledReason>
        )}
        {workflow && controls.rerunAll && (
          <DisabledReason reason={reason}>
            <Button
              size="xs"
              variant="ghost"
              disabled={rerun.pending || context.disabled}
              onClick={() =>
                void rerun.run({
                  kind: "rerun",
                  runId: workflow.runId,
                  attempt: workflow.attempt,
                  jobs: "all",
                })
              }
            >
              Re-run all jobs
            </Button>
          </DisabledReason>
        )}
        {controls.fix && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              agent.ask(checkFixRequest(check, { number: pr.number, url: detail.status.url }, run))
            }
          >
            <SparkleIcon aria-hidden size={12} />
            Fix with agent
          </Button>
        )}
        {blank && !note && openOnGitHub}
      </div>
      <Annotations
        annotations={run.annotations}
        truncated={run.annotationsTruncated}
        onOpenCode={props.onOpenCode}
      />
      {!run.log && <Output run={run} context={context} onOpen={props.onOpen} />}
      {run.log && workflow && (
        <Steps
          steps={workflow.steps}
          onJump={(line) => setJump((current) => ({ line, seq: (current?.seq ?? 0) + 1 }))}
        />
      )}
      {run.log && <PrCheckLog log={run.log} name={check.name} jump={jump} />}
      {note && <p className="text-ui text-muted-foreground">{note}</p>}
    </div>
  );
}
