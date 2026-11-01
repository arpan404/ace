import type { UsageLine, UsageSuggestion } from "@ace/ui-core";
import { useState } from "react";

/**
 * The page's Now: one sentence on who has room or who is out, then, when another account of a
 * provider has clearly more room, the suggestion with its action as a link.
 */
export function NowLine(props: {
  line: UsageLine | undefined;
  suggestion: UsageSuggestion | undefined;
  /** Makes the suggested account the default; undefined when it can't be done from here. */
  act: ((suggestion: UsageSuggestion) => Promise<void>) | undefined;
}) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const { line, suggestion, act } = props;
  if (!line) return null;
  return (
    <section aria-label="Now" className="mt-1">
      <p className="text-lg leading-snug font-semibold tracking-[-0.01em]" data-testid="usage-now">
        {line.parts.map((part, index) =>
          part.strong ? (
            <b key={part.text}>{part.text}</b>
          ) : (
            <span
              key={part.text}
              className={index > 0 ? "font-medium text-muted-foreground" : ""}
            >
              {part.text}
            </span>
          ),
        )}
      </p>
      {suggestion && (
        <p className="mt-1 text-ui text-muted-foreground" data-testid="usage-suggestion">
          {suggestion.text}{" "}
          {act ? (
            <button
              type="button"
              disabled={state === "busy"}
              onClick={() => {
                setState("busy");
                act(suggestion).then(
                  () => setState("idle"),
                  () => setState("failed"),
                );
              }}
              className="rounded-xs font-medium text-foreground underline decoration-faint-foreground underline-offset-3 hover:decoration-foreground focus-ring disabled:opacity-60"
            >
              {suggestion.action}
            </button>
          ) : null}
          {state === "failed" && (
            <span role="status" className="ml-2 text-status-failed">
              Couldn't change the default. Try again.
            </span>
          )}
        </p>
      )}
    </section>
  );
}
