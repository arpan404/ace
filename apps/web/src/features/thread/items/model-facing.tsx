import { CaretRightIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { handoffSummary, resultLead } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/**
 * The text ace sent the model on the person's behalf, kept out of sight: instructions,
 * JSON and paging hints are for the model, not for reading (IR-8, IR-11).
 */
export function ModelFacing(props: { text: string; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  const summary = handoffSummary(props.text) ?? readableSummary(props.text);
  return (
    <div className={props.className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {props.label ?? "What the agent received"}
        <CaretRightIcon
          aria-hidden
          size={11}
          className={cn("transition-transform duration-(--dur-2)", open && "rotate-90")}
        />
      </button>
      {open && (
        <div
          id={body}
          className="fx-rise-in mt-1 text-ui whitespace-pre-wrap text-muted-foreground"
        >
          <p>{summary}</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs">Details</summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
              {props.text}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

/** Provider context may be prose or a JSON envelope; only readable strings belong in the summary. */
function readableSummary(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) {
      for (const key of ["summary", "text", "result", "message"]) {
        const field: unknown = Reflect.get(value, key);
        if (typeof field === "string") return field;
      }
    }
    return "The agent received context from the previous work.";
  } catch {
    return resultLead(text) || "The agent received context from the previous work.";
  }
}
