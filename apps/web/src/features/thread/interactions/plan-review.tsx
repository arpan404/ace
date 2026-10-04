import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { Answer } from "./answer.ts";

/** A plan to approve as is, or send back with feedback. */
export function PlanReview(props: { disabled: boolean; onAnswer: Answer; children: ReactNode }) {
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="max-h-80 overflow-auto rounded-md bg-code px-3.5 py-2.5">
        {props.children}
      </div>
      {revising && (
        <textarea
          aria-label="What should change"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={3}
          placeholder="What should change?"
          className="resize-none rounded-md bg-transparent px-2.5 py-2 text-ui shadow-[inset_0_0_0_1px_var(--input)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
        />
      )}
      <div className="flex items-center gap-2">
        {revising ? (
          <Button
            size="sm"
            variant="primary"
            disabled={props.disabled || !feedback.trim()}
            onClick={() =>
              props.onAnswer({ kind: "plan_review", decision: "reject", feedback: feedback.trim() })
            }
          >
            Send feedback
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={props.disabled}
            onClick={() => props.onAnswer({ kind: "plan_review", decision: "approve" })}
          >
            Approve plan
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={props.disabled}
          onClick={() => setRevising(!revising)}
        >
          {revising ? "Cancel" : "Request changes"}
        </Button>
      </div>
    </div>
  );
}
