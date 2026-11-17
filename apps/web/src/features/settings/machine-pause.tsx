import { admissionWords } from "@ace/ui-core/host-care";
import { useState, type ReactNode } from "react";
import { StateWords } from "@/components/hairline-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { setPaused, useAdmission } from "@/lib/admission.ts";
import type { Machine } from "@/lib/machines.ts";

/** What pausing does, as the daemon's maintenance gate enforces it (ADR 0041). */
const explain =
  "Running agents finish; new threads and messages are turned away, queued agents wait until you resume, and scheduled automations skip runs that come due.";

/**
 * A machine page's "Pause new work", for its header: the button that pauses or resumes, and,
 * while paused or after a failed change, the line that says so. The daemon owns the state, so
 * the Paused banner and the desktop tray follow it. Undefined while offline and on a daemon that
 * predates pausing from a client.
 */
export function useMachinePause(
  machine: Machine,
): { button: ReactNode; line: ReactNode } | undefined {
  const admission = useAdmission(machine.client);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const client = machine.client;
  if (!client || !admission) return undefined;
  const words = admissionWords(admission);
  const change = () => {
    setPending(true);
    setProblem("");
    void setPaused(client, !words.paused, machine.name)
      .then((outcome) => setProblem(outcome.ok ? "" : outcome.problem))
      .finally(() => setPending(false));
  };
  return {
    button: (
      <Button
        id="machine.pause"
        data-row="machine-pause"
        size="sm"
        variant="ghost"
        title={explain}
        disabled={pending || !words.canChange}
        onClick={change}
      >
        {words.action}
      </Button>
    ),
    line: (words.line || problem) && (
      <>
        {words.line && (
          <span className="block">
            <StateWords tone="warn">{words.line}</StateWords>
          </span>
        )}
        {problem && (
          <span role="alert" className="block text-foreground">
            {problem}
          </span>
        )}
      </>
    ),
  };
}
