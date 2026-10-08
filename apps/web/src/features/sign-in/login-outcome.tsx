import { WarningIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { Actions, StepTitle, useFocusOnShow } from "./login-parts.tsx";

/*
 * How a sign-in ended: signed in (a check that draws itself, then the dialog closes on its own),
 * or it didn't, with one way to try again.
 */

export function Done(props: { title: string; line: string; onClose(): void }) {
  return (
    <div className="flex items-center gap-2">
      <p role="status" className="min-w-0 flex-1 text-sm">
        {props.line}
      </p>
      <Button size="sm" onClick={props.onClose}>
        Done
      </Button>
    </div>
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
