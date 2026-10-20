import type { ToolRefusal } from "@ace/ui-core";
import { RobotIcon } from "@phosphor-icons/react";
import { StaticRow } from "./transcript-row.tsx";

/**
 * A refused or failed agent tool as one failed tool row: the icon, what failed in a person's
 * words, the reason once when there is one, and ×N when the agent tried the same thing again.
 * The words the tool gave the agent stay with the agent.
 */
export function RefusalRow(props: { refusal: ToolRefusal; count: number }) {
  const { refusal, count } = props;
  return (
    <div
      role="group"
      aria-label={refusal.reason ? `${refusal.label}: ${refusal.reason}` : refusal.label}
    >
      <StaticRow
        lead={<RobotIcon aria-hidden size={16} className="text-status-failed" />}
        tone="strong"
        title={refusal.label}
        subtitle={refusal.reason ? <span title={refusal.reason}>{refusal.reason}</span> : undefined}
        meta={count > 1 ? <span aria-label={`${count} times`}>×{count}</span> : undefined}
      />
    </div>
  );
}
