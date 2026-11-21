import type { WholeRequest } from "@ace/client-react";
import { wholeRequestFailure, wholeRequestLoading } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";

/**
 * What a card says of a request its thread sent summarized (ADR 0157): that it is loading in
 * full, or why it couldn't, with Retry. Nothing once it came whole or has loaded.
 */
export function WholeRequestNote(props: { whole: WholeRequest | undefined }) {
  const { whole } = props;
  if (whole?.status === "loading")
    return (
      <p role="status" className="mb-2.5 text-xs text-subtle-foreground">
        {wholeRequestLoading}
      </p>
    );
  if (whole?.status !== "failed") return null;
  const failure = wholeRequestFailure(whole.code);
  return (
    <div role="alert" className="mb-2.5 flex items-center gap-2 text-xs text-status-failed">
      <p className="min-w-0 flex-1">{failure.text}</p>
      {failure.retryable && (
        <Button size="sm" variant="ghost" onClick={whole.retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Whether the person may say yes: the request came whole, or was read whole here. */
export function shownWhole(whole: WholeRequest | undefined): boolean {
  return whole?.status === "whole" || whole?.status === "loaded";
}
