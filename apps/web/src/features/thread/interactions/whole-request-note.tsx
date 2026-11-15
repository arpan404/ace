import type { WholeRequest } from "@ace/client-react";
import { Button } from "@/components/ui/button.tsx";

/** Why the whole request couldn't load, by the daemon's or the client's code. */
const failures: Record<string, string> = {
  request_not_whole_here:
    "This request came from another machine and can only be read in full there. You can decline it here.",
  read_denied: "This device can't read the whole request. You can decline it.",
  interaction_not_found: "This request is no longer open.",
};
/** Codes a retry can't change. */
const final = new Set(["request_not_whole_here", "read_denied", "interaction_not_found"]);

/**
 * What a card says of a request its thread sent summarized (ADR 0156): that it is loading in
 * full, or why it couldn't, with Retry. Nothing once it came whole or has loaded.
 */
export function WholeRequestNote(props: { whole: WholeRequest | undefined }) {
  const { whole } = props;
  if (whole?.status === "loading")
    return (
      <p role="status" className="mb-2.5 text-xs text-subtle-foreground">
        This request is too large to show with the thread. Loading it in full…
      </p>
    );
  if (whole?.status !== "failed") return null;
  return (
    <div role="alert" className="mb-2.5 flex items-center gap-2 text-xs text-status-failed">
      <p className="min-w-0 flex-1">
        {failures[whole.code] ??
          "Couldn't load the whole request. Until it loads, you can only decline it."}
      </p>
      {!final.has(whole.code) && (
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
