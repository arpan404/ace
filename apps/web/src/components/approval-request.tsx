import type { ApprovalOption, PermissionReview } from "@ace/protocol";
import { reviewReason, type ApprovalCopy, type ApprovalVerb } from "@ace/ui-core";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Suspense, useId, useState, type ReactNode } from "react";
import { AppMark } from "@/components/app-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * One approval, drawn the same on every surface that answers it (the thread's card above the
 * composer, Activity, computer use's app requests): the one thing it acts on, one plain reason,
 * then Allow once, Always allow and Deny. The rest (who reviewed it, the facts, a medium risk, any
 * other option the request offers) waits behind Details, so the decision row always fits.
 */

/** ace's review in words: loaded with the Details that show it. */
const ReviewSummary = deferredComponent(() =>
  import("./permission-review.tsx").then((module) => module.PermissionReviewSummary),
);
/** Warm the Details' review while the browser is idle, so opening them never waits. */
export const preloadApprovalDetails = ReviewSummary.preload;

const block =
  "max-h-40 overflow-auto rounded-md bg-code px-3 py-[9px] font-mono text-xs leading-[1.5] whitespace-pre-wrap break-words text-foreground";

/** The heading's words, beside the app's mark when the request is about an app. */
export function ApprovalHeading(props: { copy: ApprovalCopy }) {
  const { copy } = props;
  if (!copy.app) return copy.heading;
  return (
    <span className="flex items-center gap-2">
      <AppMark name={copy.app} bundleId={copy.bundleId} />
      {copy.heading}
    </span>
  );
}

export interface ApprovalAnswer {
  option: ApprovalOption;
  /** Which of the three verbs it is; undefined for another option, picked under Details. */
  verb: ApprovalVerb | undefined;
}

export function ApprovalRequest(props: {
  copy: ApprovalCopy;
  review?: PermissionReview | undefined;
  disabled?: boolean;
  onAnswer(answer: ApprovalAnswer): void;
  /** Number keys answer, in the thread: each button says its number to assistive tech. */
  numbered?: boolean;
  /** Letters drawn in the buttons, in Activity (A, D). */
  hints?: Partial<Record<ApprovalVerb, string>>;
  /** Whether a key may pick this option; a default-to-no approval takes a click. */
  keyed?: (option: ApprovalOption) => boolean;
  /** Drawn instead of the buttons once answered: the pick, sending… */
  answered?: ReactNode;
  className?: string;
}) {
  const { copy } = props;
  const [open, setOpen] = useState(false);
  const details = useId();
  const high = copy.risk?.level === "high" ? copy.risk : undefined;
  const medium = copy.risk?.level === "medium" ? copy.risk : undefined;
  const hasDetails = !!medium || copy.facts.length > 0 || !!props.review || copy.others.length > 0;
  return (
    <div className={cn("flex flex-col gap-2.5", props.className)}>
      {copy.command && <pre className={block}>{copy.command}</pre>}
      {copy.code && (
        <pre aria-label="Script" className={block}>
          {copy.code}
        </pre>
      )}
      {copy.files.length > 0 && (
        <ul aria-label="Files to upload" className={block}>
          {copy.files.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      )}
      {copy.reason && <p className="text-ui text-muted-foreground">{copy.reason}</p>}
      {high && (
        <p className="text-ui text-muted-foreground">
          <b className="mr-[7px] font-medium text-status-failed">High risk.</b>
          {high.text}
        </p>
      )}
      {props.answered || (
        <div className="flex flex-wrap items-center gap-2">
          {copy.decisions.map((decision, index) => {
            const hint = props.hints?.[decision.verb];
            const keyed = props.keyed?.(decision.option) ?? true;
            const button = (
              <Button
                key={decision.option.id}
                size="sm"
                variant={
                  decision.emphasis === "primary"
                    ? "primary"
                    : decision.emphasis === "secondary"
                      ? "secondary"
                      : "ghost"
                }
                disabled={props.disabled}
                aria-keyshortcuts={
                  props.numbered && keyed
                    ? String(index + 1)
                    : keyed
                      ? hint?.toLowerCase()
                      : undefined
                }
                onClick={() => props.onAnswer({ option: decision.option, verb: decision.verb })}
              >
                {decision.label}
                {hint && keyed && (
                  <Kbd
                    aria-hidden
                    variant={decision.emphasis === "primary" ? "on-primary" : "default"}
                    className="ml-1"
                  >
                    {hint}
                  </Kbd>
                )}
              </Button>
            );
            return decision.scope ? (
              <Tip key={decision.option.id} label={decision.scope} side="top">
                {button}
              </Tip>
            ) : (
              button
            );
          })}
          {hasDetails && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={details}
              onClick={() => setOpen(!open)}
              className="ml-auto flex items-center gap-1 rounded-xs text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-ring"
            >
              Details
              <CaretRightIcon
                aria-hidden
                size={12}
                className={cn(
                  "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
                  open && "rotate-90",
                )}
              />
            </button>
          )}
        </div>
      )}
      {open && (
        <div id={details} className="fx-rise-in flex flex-col gap-2">
          {medium && (
            <p className="text-sm text-muted-foreground">
              <b className="mr-[7px] font-medium text-status-needs-you">Check first.</b>
              {medium.text}
            </p>
          )}
          {copy.facts.length > 0 && (
            <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm leading-5">
              {copy.facts.map((fact) => (
                <div key={`${fact.label}:${fact.value}`} className="contents">
                  <dt className="text-subtle-foreground">{fact.label}</dt>
                  <dd
                    className={cn(
                      "min-w-0 break-words text-muted-foreground",
                      fact.code && "font-mono text-xs whitespace-pre-wrap text-foreground",
                    )}
                  >
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {props.review && (
            <Suspense fallback={null}>
              <ReviewSummary.Component
                review={props.review}
                reasonShown={copy.reason === reviewReason(props.review)}
                commandShown={!!copy.command}
              />
            </Suspense>
          )}
          {copy.others.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {copy.others.map((choice) => (
                <Button
                  key={choice.option.id}
                  size="sm"
                  variant="ghost"
                  disabled={props.disabled}
                  onClick={() => props.onAnswer({ option: choice.option, verb: undefined })}
                >
                  {choice.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
