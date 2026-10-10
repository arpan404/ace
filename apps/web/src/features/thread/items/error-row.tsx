import type { Item, ProviderKind } from "@ace/protocol";
import { describeProviderError, type ErrorInput, type ErrorView } from "@ace/ui-core";
import { CaretRightIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useSignIn } from "@/features/sign-in/index.ts";

const linkButton = buttonVariants({ variant: "primary", size: "sm" });

/** The composer's own model control: the one place a thread's model changes. */
function openModelPicker(from: HTMLElement | null) {
  const scope = from?.closest("main") ?? document;
  scope.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')?.click();
}

/** A notice's structured error fields (C-A `code`/`title`/`detail`, #116 `details`), if any. */
export function noticeError(item: Extract<Item, { type: "notice" }>): ErrorInput {
  const record = item as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  const details =
    typeof record["details"] === "object" && record["details"] !== null
      ? (record["details"] as Record<string, unknown>)
      : {};
  return {
    text: item.text,
    code: text("code") ?? (typeof details["code"] === "string" ? details["code"] : undefined),
    title: text("title"),
    detail: text("detail"),
    provider:
      typeof details["provider"] === "string" ? (details["provider"] as ProviderKind) : undefined,
    model: typeof details["model"] === "string" ? details["model"] : undefined,
  };
}

/**
 * One failure as one row (IR-12): what went wrong in words, the action that fixes it, and the
 * provider's own text behind "Details". `onRetry` adds Retry where a retry is possible. A
 * notice and a failed turn's ending both draw it, so a failure reads the same wherever it shows.
 */
export function ErrorRow(props: {
  error: ErrorInput | ErrorView;
  /** "Turn failed", for the end of a turn: the failure's words follow it. */
  heading?: string | undefined;
  onRetry?: (() => void) | undefined;
  /** A retry is on its way: Retry waits. */
  retrying?: boolean | undefined;
  className?: string | undefined;
}) {
  const view = "text" in props.error ? describeProviderError(props.error) : props.error;
  const signIn = useSignIn();
  const signInTo = view.provider;
  const [open, setOpen] = useState(false);
  const details = useId();
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const title = props.heading ?? view.title;
  const message = props.heading ? (view.message ?? view.title) : view.message;
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
            <Button size="sm" variant="primary" onClick={() => openModelPicker(row)}>
              Change model
            </Button>
          )}
          {view.action === "sign_in" &&
            (signIn && signInTo ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-ring-text"
                onClick={() => signIn({ provider: signInTo })}
              >
                Sign in
              </Button>
            ) : (
              <Link to="/settings/providers" className={linkButton}>
                Sign in
              </Link>
            ))}
          {view.action === "switch_account" && (
            <Link to="/accounts" className={linkButton}>
              Use another account
            </Link>
          )}
          {props.onRetry && (
            <Button size="sm" variant="primary" disabled={props.retrying} onClick={props.onRetry}>
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
        <p
          id={details}
          className="fx-rise-in mt-1 ml-6 text-ui leading-normal whitespace-pre-wrap text-muted-foreground"
        >
          {raw}
        </p>
      )}
    </div>
  );
}
