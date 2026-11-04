import { admissionWords } from "@ace/ui-core/host-care";
import { useState } from "react";
import { HairlineRow, RowAction, RowGroup, StateWords } from "@/components/hairline-row.tsx";
import { setPaused, useAdmission } from "@/lib/admission.ts";
import type { Machine } from "@/lib/machines.ts";

/** What pausing does, as the daemon's maintenance gate enforces it (ADR 0041). */
const explain =
  "Running agents finish; new threads and messages are turned away, and queued agents wait until you resume.";

/**
 * A machine page's "Pause new work": whether the machine takes new work and the one action that
 * changes it. The daemon owns the state, so the Paused banner and the desktop tray follow it.
 * Hidden while offline and on a daemon that predates pausing from a client.
 */
export function MachinePause(props: { machine: Machine }) {
  const { machine } = props;
  const admission = useAdmission(machine.client);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const client = machine.client;
  if (!client || !admission) return null;
  const words = admissionWords(admission);
  const change = () => {
    setPending(true);
    setProblem("");
    void setPaused(client, !words.paused, machine.name)
      .then((outcome) => setProblem(outcome.ok ? "" : outcome.problem))
      .finally(() => setPending(false));
  };
  return (
    <RowGroup label="New work">
      <HairlineRow
        id="machine.pause"
        data-row="machine-pause"
        title={
          words.line ? <StateWords tone="warn">{words.line}</StateWords> : "Taking new work"
        }
        sub={
          <>
            <span className="block">{explain}</span>
            {problem && (
              <span role="alert" className="block text-foreground">
                {problem}
              </span>
            )}
          </>
        }
        actions={
          <RowAction disabled={pending || !words.canChange} onClick={change}>
            {words.action}
          </RowAction>
        }
      />
    </RowGroup>
  );
}
