import type { ToolRefusal } from "@ace/ui-core";
import { RobotIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { StaticRow, TranscriptRow, rowDetailIndent } from "./transcript-row.tsx";

/**
 * A refused agent tool as one failed tool row: the icon, what was refused, the reason once,
 * and ×N when the agent tried the same thing again. The row opens to the details only when
 * they say more.
 */
export function RefusalRow(props: { refusal: ToolRefusal; count: number }) {
  const { refusal, count } = props;
  const [open, setOpen] = useState(false);
  const details = useId();
  const parts = {
    lead: <RobotIcon aria-hidden size={16} className="text-status-failed" />,
    tone: "strong" as const,
    title: refusal.label,
    subtitle: <span title={refusal.reason}>{refusal.reason}</span>,
    meta: count > 1 ? <span aria-label={`${count} times`}>×{count}</span> : undefined,
  };
  return (
    <div role="group" aria-label={`${refusal.label}: ${refusal.reason}`}>
      {refusal.detail ? (
        <TranscriptRow
          {...parts}
          expanded={open}
          controls={details}
          label={`Details of ${refusal.label}`}
          onToggle={() => setOpen(!open)}
        />
      ) : (
        <StaticRow {...parts} />
      )}
      {open && refusal.detail && (
        <p
          id={details}
          className={`fx-rise-in mt-1 text-ui whitespace-pre-wrap text-muted-foreground ${rowDetailIndent}`}
        >
          {refusal.detail}
        </p>
      )}
    </div>
  );
}
