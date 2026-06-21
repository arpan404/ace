import type { ErrorComponentProps } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, CopyIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { APP_ELEVATED_INSET_CLASS_NAME } from "../lib/appChrome";
import { cn } from "../lib/utils";

export function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);
  const [copiedDetails, setCopiedDetails] = useState(false);

  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopiedDetails(true);
      window.setTimeout(() => setCopiedDetails(false), 1600);
    } catch {
      setCopiedDetails(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="min-h-0 flex-1 overflow-y-auto">
        <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-5 py-10 sm:px-6">
          <div className={cn(APP_ELEVATED_INSET_CLASS_NAME, "min-w-0 px-5 py-5 sm:px-6 sm:py-6")}>
            <div className="min-w-0 border-b border-border/30 pb-7">
              <div className="flex items-center gap-2.5 text-foreground">
                <span className="text-[15px] leading-none font-semibold tracking-tight">
                  {APP_BASE_NAME}
                </span>
              </div>
              <h1 className="mt-5 text-[24px] leading-8 font-semibold tracking-tight text-foreground sm:text-[28px] sm:leading-9">
                Something went wrong
              </h1>
              <p className="mt-2 max-w-xl text-[13px] leading-5 text-muted-foreground">
                Try again or reload.
              </p>
            </div>

            <div className="flex min-w-0 flex-col gap-4 border-b border-border/30 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <Button
                  size="default"
                  variant="ghost"
                  onClick={() => reset()}
                  className="h-8 gap-1.5 px-2.5 text-[12px]/none font-medium text-foreground/86 shadow-none hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.08]"
                >
                  <RotateCcwIcon className="size-3.5" />
                  Try again
                </Button>
                <Button
                  size="default"
                  variant="ghost"
                  onClick={() => window.location.reload()}
                  className="h-8 gap-1.5 px-2.5 text-[12px]/none font-medium text-muted-foreground/78 shadow-none hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.08]"
                >
                  <RefreshCwIcon className="size-3.5" />
                  Reload
                </Button>
              </div>
            </div>

            <div className="border-b border-border/30">
              <div className="grid gap-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div className="min-w-0">
                  <p className="mt-1 max-w-2xl text-[12px] leading-5 break-words text-muted-foreground">
                    {message}
                  </p>
                </div>
                <Button
                  size="default"
                  variant="ghost"
                  onClick={() => void copyDetails()}
                  className="h-8 justify-self-start gap-1.5 px-2.5 text-[12px]/none font-medium text-muted-foreground/78 shadow-none hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.08] sm:justify-self-end"
                >
                  {copiedDetails ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                  {copiedDetails ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>

            <details className="group mt-5">
              <summary className="flex h-8 cursor-pointer list-none items-center justify-between gap-3 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground">
                <span>Details</span>
                <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <pre className="max-h-72 overflow-auto border-t border-border/25 py-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">
                {details}
              </pre>
            </details>
          </div>
        </section>
      </main>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}
