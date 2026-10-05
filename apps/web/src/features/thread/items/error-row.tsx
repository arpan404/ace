import { describeProviderError, type ErrorInput, type ErrorView } from "@ace/ui-core";
import { CaretRightIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";

const linkButton = buttonVariants({ variant: "secondary", size: "sm" });

/** The composer's own model control: the one place a thread's model changes. */
function openModelPicker(from: HTMLElement | null) {
  const scope = from?.closest("main") ?? document;
  scope.querySelector<HTMLButtonElement>('button[aria-label^="Change model"]')?.click();
}

/**
 * One failure as one row (IR-12): what went wrong in words, the action that fixes it, and the
 * provider's own text behind "Details". `onRetry` adds Retry where a retry is possible.
 */
export function ErrorRow(props: {
  error: ErrorInput | ErrorView;
  /** "Turn failed", for the end of a turn; the error's own title otherwise. */
  heading?: string | undefined;
  onRetry?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const view = "text" in props.error ? describeProviderError(props.error) : props.error;
  const [open, setOpen] = useState(false);
  const details = useId();
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const title = props.heading ?? view.title;
  const message = props.heading ? view.title : view.message;
  const raw = view.raw && view.raw !== title && view.raw !== message ? view.raw : undefined;
  return (
    <div
      ref={setRow}
      role="group"
      aria-label={`${title}${message ? `: ${message}` : ""}`}
      className={cn("text-ui", props.className)}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <WarningCircleIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
        <span className="font-medium text-foreground">{title}</span>
        {message && <span className="min-w-0 text-muted-foreground">· {message}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {view.action === "change_model" && (
            <Button size="sm" variant="secondary" onClick={() => openModelPicker(row)}>
              Change model
            </Button>
          )}
          {view.action === "sign_in" && (
            <Link to="/settings/providers" className={linkButton}>
              Sign in
            </Link>
          )}
          {view.action === "switch_account" && (
            <Link to="/more/accounts" className={linkButton}>
              Use another account
            </Link>
          )}
          {props.onRetry && (
            <Button size="sm" variant="secondary" onClick={props.onRetry}>
              Retry
            </Button>
          )}
          {raw && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-controls={details}
              onClick={() => setOpen(!open)}
            >
              Details
              <CaretRightIcon
                aria-hidden
                size={12}
                className={cn("transition-transform duration-(--dur-2)", open && "rotate-90")}
              />
            </Button>
          )}
        </span>
      </div>
      {open && raw && (
        <pre
          id={details}
          className="fx-rise-in mt-1 ml-6 max-h-60 overflow-auto rounded-md bg-code px-3 py-2 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap text-muted-foreground"
        >
          {raw}
        </pre>
      )}
    </div>
  );
}
