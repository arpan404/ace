import { formatCount, type OffshiftSummary } from "@ace/ui-core";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { threadGlyph } from "@/components/status-glyph-state.ts";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * The thread's Offshift run: its state and phase, what blocks it, the evidence it still needs,
 * the current phase's steps, and its outcome and criteria behind a disclosure.
 */
export function OffshiftRun(props: { run: OffshiftSummary }) {
  const { run } = props;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-2 text-ui">
      <p
        role="status"
        aria-label={`Offshift run: ${run.word} · ${run.phase}`}
        className="flex h-7 min-w-0 items-center gap-2"
      >
        <StatusGlyph state={threadGlyph({ tone: run.tone, mark: "none" })} tone={run.tone} />
        <span data-tone={run.tone} className="font-medium text-(--tone-text)">
          {run.word}
        </span>
        <span className="min-w-0 truncate text-muted-foreground tabular-nums">{run.phase}</span>
      </p>
      {run.blocker && (
        <p aria-label="Blocker" className="min-w-0 break-words text-foreground">
          {run.blocker}
        </p>
      )}
      {run.missing.length > 0 && (
        <ul aria-label="Missing evidence" className="flex min-w-0 flex-col">
          {run.missing.map((item) => (
            <li key={item.key} className="flex h-7 min-w-0 items-center gap-2">
              <span className="min-w-0 truncate" title={item.description}>
                {item.description}
              </span>
              <span className="shrink-0 text-xs text-subtle-foreground">{item.kind}</span>
            </li>
          ))}
          {run.moreMissing > 0 && (
            <li className="flex h-7 items-center text-xs text-subtle-foreground tabular-nums">
              +{formatCount(run.moreMissing)}
            </li>
          )}
        </ul>
      )}
      {run.steps.length > 0 && (
        <ul aria-label="Steps" className="flex min-w-0 flex-col">
          {run.steps.map((step) => (
            <li key={step.id} className="flex min-w-0 flex-col">
              <span className="flex h-7 min-w-0 items-center gap-2">
                <span className="min-w-0 truncate" title={step.title}>
                  {step.title}
                </span>
                <span className="ml-auto shrink-0 text-xs text-subtle-foreground">
                  {step.state}
                </span>
              </span>
              {step.reason && (
                <span className="min-w-0 pb-1 text-xs break-words text-muted-foreground">
                  {step.reason}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Disclosure summary="Outcome and criteria" summaryClassName="h-7">
        <div className="flex min-w-0 flex-col gap-1.5 pt-1 pl-4.5">
          <p className="min-w-0 break-words text-foreground">{run.outcome}</p>
          <ul aria-label="Criteria" className="flex min-w-0 flex-col">
            {run.criteria.map((criterion) => (
              <li key={criterion.id} className="flex min-w-0 flex-col py-1">
                <span className="min-w-0 break-words">
                  {criterion.description}
                  {criterion.independent && (
                    <span className="ml-2 text-xs text-subtle-foreground">Independent</span>
                  )}
                </span>
                <span className="flex min-w-0 flex-col text-xs text-muted-foreground">
                  {criterion.evidence.map((evidence) => (
                    <span key={evidence.kind} className="min-w-0 truncate">
                      {evidence.kind} ·{" "}
                      <span
                        data-tone={evidence.tone}
                        className={cn(evidence.tone && "text-(--tone-text)")}
                      >
                        {evidence.state}
                      </span>
                      {evidence.by && ` · ${evidence.by}`}
                    </span>
                  ))}
                </span>
              </li>
            ))}
            {run.moreCriteria > 0 && (
              <li className="py-1 text-xs text-subtle-foreground tabular-nums">
                +{formatCount(run.moreCriteria)}
              </li>
            )}
          </ul>
        </div>
      </Disclosure>
    </div>
  );
}
