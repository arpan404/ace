import { Link } from "@tanstack/react-router";
import type { AutomationRun } from "@ace/protocol";

/** Shared by Activity and an automation's history: the complete stored output or error. */
export function RunOutput(props: { run: AutomationRun }) {
  const { run } = props;
  return (
    <section aria-label={run.status === "failed" ? "Run error" : "Run output"} className="mt-3">
      <h3 className="text-sm font-medium">{run.status === "failed" ? "Error" : "Output"}</h3>
      <p className="mt-1 text-ui whitespace-pre-wrap wrap-anywhere">
        {run.result ??
          (run.status === "running"
            ? "Output will appear when this run finishes."
            : "No output was saved for this run.")}
      </p>
      {run.threadId && (
        <Link
          to="/t/$threadId"
          params={{ threadId: run.threadId }}
          className="mt-2 inline-block text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          Open thread
        </Link>
      )}
    </section>
  );
}
