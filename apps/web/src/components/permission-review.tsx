import type { PermissionReview } from "@ace/protocol";
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

/** Who decided and the exact input judged, as a two-column list. */
function ReviewFacts(props: { view: ReviewView; className?: string }) {
  const { view } = props;
  return (
    <dl
      className={cn(
        "grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm leading-5",
        props.className,
      )}
    >
      <dt className="text-subtle-foreground">Reviewer</dt>
      <dd className="min-w-0 text-muted-foreground">{view.reviewer}</dd>
      <dt className="text-subtle-foreground">Reason</dt>
      <dd className="min-w-0 text-foreground">{view.reason}</dd>
      <dt className="text-subtle-foreground">Tool</dt>
      <dd className="min-w-0 text-muted-foreground">{view.tool}</dd>
      {view.target.map((line) => (
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
export function PermissionReviewNote(props: { review: PermissionReview; waiting: boolean }) {
  const view = describeReview(props.review);
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
 * Inside an approval card: why ace sent the request to a person rather than deciding it, and
 * exactly what it judged.
 */
export function PermissionReviewSummary(props: { review: PermissionReview; className?: string }) {
  const view = describeReview(props.review);
  return (
    <section
      aria-label="ace's review"
      className={cn("rounded-md bg-muted px-3 py-2.5", props.className)}
    >
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon icon={glyphs[view.tone]} size={14} className="text-subtle-foreground" />
        <span>
          <b className="font-medium text-foreground">{view.verdict}</b>
          {view.tone === "escalated" && " · ace's risk policy wants your decision"}
        </span>
      </p>
      <ReviewFacts view={view} className="mt-2" />
    </section>
  );
}
