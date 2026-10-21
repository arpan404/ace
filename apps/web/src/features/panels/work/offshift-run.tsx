import type { OffshiftCriterionRow, OffshiftStepRow, OffshiftSummary } from "@ace/ui-core";
import { formatCount } from "@ace/ui-core";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { threadGlyph, type GlyphState } from "@/components/status-glyph-state.ts";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * The thread's Offshift run: its state and phase, what blocks it, the current phase's steps,
 * one row per criterion with the checks it still needs, and the outcome behind a disclosure.
 */
export function OffshiftRun(props: { run: OffshiftSummary }) {
  const { run } = props;
  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 text-ui">
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
        <p aria-label="Blocker" className="min-w-0 pl-5.5 break-words text-foreground">
          {run.blocker}
        </p>
      )}
      {run.steps.length > 0 && (
        <ul aria-label="Steps" className="flex min-w-0 flex-col">
          {run.steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
      {run.criteria.length > 0 && (
        <Disclosure
          open
          summary={
            <>
              Criteria
              <span className="text-xs text-subtle-foreground tabular-nums">
                {formatCount(run.criteria.length + run.moreCriteria)}
              </span>
            </>
          }
          summaryClassName="h-7"
        >
          <ul aria-label="Criteria" className="flex min-w-0 flex-col">
            {run.criteria.map((criterion) => (
              <CriterionRow key={criterion.id} criterion={criterion} />
            ))}
            {run.moreCriteria > 0 && (
              <li className="flex h-7 items-center pl-5.5 text-xs text-subtle-foreground tabular-nums">
                +{formatCount(run.moreCriteria)}
              </li>
            )}
          </ul>
        </Disclosure>
      )}
      <Disclosure summary="Outcome" summaryClassName="h-7">
        <p className="min-w-0 pb-1 pl-4.5 break-words text-muted-foreground">{run.outcome}</p>
      </Disclosure>
    </div>
  );
}

const stepGlyphs: Record<OffshiftStepRow["state"], GlyphState> = {
  Done: "done",
  Skipped: "idle",
  "To do": "idle",
};

/** A step: done and skipped steps step back a tier; a skipped one says why underneath. */
function StepRow(props: { step: OffshiftStepRow }) {
  const { step } = props;
  const todo = step.state === "To do";
  return (
    <li className="flex min-w-0 flex-col">
      <span className="flex h-7 min-w-0 items-center gap-2">
        <StatusGlyph
          state={stepGlyphs[step.state]}
          tone={step.state === "Done" ? "done" : "idle"}
          label={step.state}
        />
        <span
          className={cn("min-w-0 truncate", !todo && "text-muted-foreground")}
          title={step.title}
        >
          {step.title}
        </span>
      </span>
      {step.reason && (
        <span className="min-w-0 pb-1 pl-5.5 text-xs break-words text-subtle-foreground">
          {step.reason}
        </span>
      )}
    </li>
  );
}

const criterionGlyphs: Record<OffshiftCriterionRow["state"], GlyphState> = {
  Met: "done",
  Failed: "failed",
  Open: "idle",
};

/** A criterion and, at the right, the checks it still needs; hovering lists each check. */
function CriterionRow(props: { criterion: OffshiftCriterionRow }) {
  const { criterion } = props;
  return (
    <li
      className="flex h-7 min-w-0 items-center gap-2"
      title={`${criterion.description}\n${criterion.detail}`}
    >
      <StatusGlyph
        state={criterionGlyphs[criterion.state]}
        tone={criterion.state === "Open" ? "idle" : undefined}
        label={criterion.state}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          criterion.state === "Met" && "text-muted-foreground",
        )}
      >
        {criterion.description}
      </span>
      {criterion.needs.length > 0 && (
        <span aria-label="Needs" className="shrink-0 text-xs text-subtle-foreground">
          {criterion.needs.map((need, index) => (
            <span key={need.kind}>
              {index > 0 && " · "}
              <span
                data-tone={need.failed ? "failed" : undefined}
                className={cn(need.failed && "text-(--tone-text)")}
              >
                {need.kind}
              </span>
            </span>
          ))}
        </span>
      )}
    </li>
  );
}
