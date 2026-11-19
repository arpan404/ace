import type { Item } from "@ace/protocol";
import { momentLine, type MomentKind, type MomentLine } from "@ace/ui-core";
import { ArrowClockwiseIcon, ClockCounterClockwiseIcon, LightningIcon } from "@ace/icons";
import { useCallback } from "react";
import { flatEqual, useItemsSelect } from "../lib/use-items.ts";
import { SystemRow } from "./system-row.tsx";

const icons = {
  restart: ArrowClockwiseIcon,
  resume: ClockCounterClockwiseIcon,
  automation: LightningIcon,
} as const;

/**
 * One moment of a turn as one quiet row (`turn-moments.ts`): "Restarted twice, continued
 * 9:23–9:30 AM", "Waited for the usage limit", "2 subagents finished". What ace sent the agent
 * stays folded behind the row until asked for.
 */
export function MomentRow(props: {
  threadId: string;
  moment: MomentKind;
  itemIds: readonly string[];
  since?: number | undefined;
}) {
  const { moment, since } = props;
  const read = useCallback(
    (items: readonly (Item | undefined)[]) =>
      momentLine(
        moment,
        items.filter((item) => item !== undefined),
        since,
      ),
    [moment, since],
  );
  const line = useItemsSelect(props.threadId, props.itemIds, read, sameLine);
  if (!line) return null;
  const Glyph = icons[line.icon];
  return (
    <SystemRow
      text={line.text}
      at={line.from}
      until={line.to > line.from ? line.to : undefined}
      icon={<Glyph aria-hidden size={14} />}
    >
      {line.received && <p className="font-mono">{line.received}</p>}
    </SystemRow>
  );
}

const sameLine = (a: MomentLine | undefined, b: MomentLine | undefined) =>
  a === b || (!!a && !!b && flatEqual(a, b));
