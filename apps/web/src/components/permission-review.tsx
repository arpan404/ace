import type { Interaction, PermissionReview } from "@ace/protocol";
import { describeReview, type ReviewTone, type ReviewView } from "@ace/ui-core";
import {
  CaretRightIcon,
  ShieldCheckIcon,
  ShieldSlashIcon,
  ShieldWarningIcon,
} from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { cn } from "@/lib/cn.ts";

const glyphs: Record<ReviewTone, IconGlyph> = {
  approved: ShieldCheckIcon,
  denied: ShieldSlashIcon,
  escalated: ShieldWarningIcon,
};

/**
 * Who decided and the exact input judged, as a two-column list. On an approval card (`card`) the
 * tool goes, and so do the reason and the command when the card already shows them.
 */
export function ReviewFacts(props: {
  view: ReviewView;
  card?: { reasonShown: boolean; commandShown: boolean } | undefined;
  className?: string;
}) {
  const { view, card } = props;
  const target = card?.commandShown
    ? view.target.filter((line) => line.label !== "Command")
    : view.target;
  return (
    <dl
      className={cn(
        "grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm leading-5",
        props.className,
      )}
    >
      <dt className="text-subtle-foreground">Reviewer</dt>
      <dd className="min-w-0 text-muted-foreground">{view.reviewer}</dd>
      {!card?.reasonShown && (
        <>
          <dt className="text-subtle-foreground">Reason</dt>
          <dd className="min-w-0 text-foreground">{view.reason}</dd>
        </>
      )}
      {!card && (
        <>
          <dt className="text-subtle-foreground">Tool</dt>
          <dd className="min-w-0 text-muted-foreground">{view.tool}</dd>
        </>
      )}
      {target.map((line) => (
        <div key={`${line.label}:${line.value}`} className="contents">
          <dt className="text-subtle-foreground">{line.label}</dt>
          <dd
            className={cn(
              "min-w-0 break-words text-muted-foreground",
              line.code && "font-mono text-[12px] whitespace-pre-wrap text-foreground",
            )}
          >
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One permission review in the transcript: what ace's risk policy decided and why, on one quiet
 * line; the reviewer and the exact command, directory and paths it judged open beneath it. A
 * request sent to the person carries the needs-you dot only while it still `waiting` for them.
 */
export function PermissionReviewNote(props: {
  review: PermissionReview;
  interaction?: Interaction | undefined;
  waiting: boolean;
}) {
  const view = describeReview(props.review, props.interaction);
  const [open, setOpen] = useState(false);
  const details = useId();
  return (
    <article aria-label={`Permission review: ${view.verdict}`} className="text-ui">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={details}
        onClick={() => setOpen(!open)}
        className="-mx-1.5 flex min-h-7 w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)]"
      >
        <Icon icon={glyphs[view.tone]} size={16} className="text-subtle-foreground" />
        <span className="shrink-0 font-medium text-foreground">{view.verdict}</span>
        {view.tone === "denied" && <Dot tone="failed" />}
        {view.tone === "escalated" && props.waiting && (
          <Dot tone="needs-you" label="Waiting for you" />
        )}
        <span className="shrink-0 text-subtle-foreground">{view.tool}</span>
        <span className="min-w-0 flex-1 truncate">{view.reason}</span>
        <CaretRightIcon
          aria-hidden
          size={12}
          className={cn(
            "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div id={details} className="fx-rise-in mt-1 mb-1 ml-6 border-l-2 pl-3">
          <ReviewFacts view={view} />
        </div>
      )}
    </article>
  );
}

/**
 * Inside an approval card's Details: who reviewed it and exactly what it judged, leaving out
 * what the card already says.
 */
export function PermissionReviewSummary(props: {
  review: PermissionReview;
  reasonShown: boolean;
  commandShown: boolean;
}) {
  return (
    <section aria-label="ace's review">
      <ReviewFacts
        view={describeReview(props.review)}
        card={{ reasonShown: props.reasonShown, commandShown: props.commandShown }}
      />
    </section>
  );
}

/** A step's review, under its output once the approval is settled: who decided, why, on what. */
export function PermissionReviewFacts(props: {
  review: PermissionReview;
  interaction?: Interaction | undefined;
  cwd?: string | undefined;
}) {
  const view = describeReview(props.review, props.interaction, { cwd: props.cwd });
  return (
    <section aria-label="ace's review" className="flex flex-col gap-1.5">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon icon={glyphs[view.tone]} size={14} className="text-subtle-foreground" />
        <b className="font-medium text-foreground">{view.verdict}</b>
      </p>
      <ReviewFacts view={view} />
    </section>
  );
}
