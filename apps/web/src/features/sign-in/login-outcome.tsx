import { WarningIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { Actions, StepTitle, useFocusOnShow } from "./login-parts.tsx";

/*
 * How a sign-in ended: signed in (a check that draws itself, then the dialog closes on its own),
 * or it didn't, with one way to try again.
 */

/** A green check in a soft disc, its stroke drawing in once. */
function DrawnCheck() {
  return (
    <span
      aria-hidden
      data-tone="done"
      className="fx-pop grid size-12 place-items-center rounded-full bg-(--tone)/12 text-(--tone)"
    >
      <svg viewBox="0 0 24 24" width={28} height={28} fill="none">
        <path
          className="fx-draw"
          pathLength={1}
          d="M5 12.5l4.5 4.5L19 7.5"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function Done(props: { title: string; line: string; onClose(): void }) {
  const primary = useFocusOnShow<HTMLButtonElement>();
  return (
    <>
      <div className="flex flex-col items-center gap-3 pt-1">
        <DrawnCheck />
        <StepTitle title={props.title} line={props.line} />
      </div>
      <Actions>
        <Button ref={primary} size="lg" variant="primary" onClick={props.onClose}>
          Done
        </Button>
      </Actions>
    </>
  );
}

export function Problem(props: {
  title: string;
  hint?: string | undefined;
  onClose(): void;
  onRetry(): void;
  /** Cancelled by the person: nothing went wrong, so no warning. */
  quiet?: boolean;
}) {
  const primary = useFocusOnShow<HTMLButtonElement>();
  return (
    <>
      <div className="flex flex-col items-center gap-3 pt-1">
        {!props.quiet && (
          <span
            aria-hidden
            data-tone="failed"
            className="fx-pop grid size-12 place-items-center rounded-full bg-(--tone)/12 text-(--tone)"
          >
            <WarningIcon size={26} weight="regular" />
          </span>
        )}
        <StepTitle title={props.title} line={props.hint} />
      </div>
      <Actions>
        <Button ref={primary} size="lg" variant="primary" onClick={props.onRetry}>
          Try again
        </Button>
        <Button size="lg" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </Actions>
    </>
  );
}
