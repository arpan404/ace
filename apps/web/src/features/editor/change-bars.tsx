import type { ProviderKind } from "@ace/protocol";
import type { LineMark } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import type { RowLayout } from "./wrap-index.ts";

/*
 * The gutter's change marks (docs/editor/workbench.md 43–44), drawn for the rows on screen only:
 * a bar at the gutter's right edge for lines added (green) or changed (blue) since the last
 * commit, a small wedge between lines where lines were removed (red), and lines an agent wrote
 * in the working thread's amber, with the agent's mark on the block's first line. Every mark
 * says what it is on hover, so none of it is colour alone. A press on a bar reaches the editor's
 * gutter handling, which opens the change.
 */

/** Lines an agent wrote: 0-based `start..end` (exclusive); empty where it only removed lines. */
export interface AgentMark {
  start: number;
  end: number;
  /** The hover: "Claude Code changed this in turn 2". */
  label: string;
  provider?: ProviderKind | undefined;
}

export const changeWords: Record<LineMark, string> = {
  added: "Added since the last commit",
  modified: "Changed since the last commit",
  removed: "Lines removed here since the last commit",
};

const barColour: Record<Exclude<LineMark, "removed">, string> = {
  added: "bg-status-done",
  modified: "bg-status-working",
};

/** The bar's width, and the strip at the gutter's edge a press on it takes. */
const barWidth = 3;
const hitWidth = 6;
const iconSize = 12;

export interface ChangeBarsProps {
  marks: ReadonlyMap<number, LineMark> | undefined;
  agent: readonly AgentMark[] | undefined;
  layout: RowLayout | undefined;
  /** Inclusive lines and the exclusive row window drawn now. */
  firstLine: number;
  lastLine: number;
  firstRow: number;
  lastRow: number;
  gutter: number;
  lineHeight: number;
  /** The text's horizontal scroll: the marks stay with the sticky gutter. */
  scrollLeft: number;
  /** A press on a bar opens its change: the pointer says so. */
  clickable: boolean;
}

/** The agent mark covering each visible line, and whether the line starts it. */
function agentLines(
  agent: readonly AgentMark[] | undefined,
  first: number,
  last: number,
): Map<number, { mark: AgentMark; starts: boolean; gap: boolean }> {
  const lines = new Map<number, { mark: AgentMark; starts: boolean; gap: boolean }>();
  for (const mark of agent ?? []) {
    if (mark.start === mark.end) {
      if (mark.start >= first && mark.start <= last)
        lines.set(mark.start, { mark, starts: true, gap: true });
      continue;
    }
    for (let line = Math.max(first, mark.start); line < mark.end && line <= last; line++)
      lines.set(line, { mark, starts: line === mark.start, gap: false });
  }
  return lines;
}

export function ChangeBars(props: ChangeBarsProps) {
  "use no memo";
  const { layout, lineHeight } = props;
  if (!layout || (!props.marks?.size && !props.agent?.length)) return null;
  const agent = agentLines(props.agent, props.firstLine, props.lastLine);
  const right = props.scrollLeft + props.gutter;
  const drawn = [];
  for (let line = props.firstLine; line <= props.lastLine; line++) {
    const kind = props.marks?.get(line + 1);
    const own = agent.get(line);
    if (!kind && !own) continue;
    const start = layout.startOf(line);
    const count = layout.rowsOf(line).length;
    const from = Math.max(start, props.firstRow);
    const to = Math.min(start + count, props.lastRow);
    if (to <= from) continue;
    const top = from * lineHeight;
    const height = (to - from) * lineHeight;
    const byAgent = own && !own.gap;
    if (byAgent || kind === "added" || kind === "modified")
      drawn.push(
        <span
          key={`bar-${line}`}
          data-change-bar={byAgent ? "agent" : kind}
          data-change-line={line + 1}
          title={byAgent ? own.mark.label : kind && changeWords[kind]}
          className={cn("pointer-events-auto absolute", props.clickable && "cursor-pointer")}
          style={{ left: right - hitWidth, top, width: hitWidth, height }}
        >
          <span
            className={cn(
              "absolute inset-y-0 right-0",
              byAgent ? "bg-status-waiting" : kind && kind !== "removed" && barColour[kind],
            )}
            style={{ width: barWidth }}
          />
        </span>,
      );
    if ((own?.gap || kind === "removed") && start >= props.firstRow)
      drawn.push(
        <span
          key={`gap-${line}`}
          data-change-bar={own?.gap ? "agent-removed" : "removed"}
          data-change-line={line + 1}
          title={own?.gap ? own.mark.label : changeWords.removed}
          className={cn("pointer-events-auto absolute", props.clickable && "cursor-pointer")}
          style={{ left: right - hitWidth - 2, top: start * lineHeight - 5, width: 8, height: 10 }}
        >
          <span
            className={cn(
              "absolute top-0.5 right-0 size-0 border-y-[4px] border-r-[5px] border-y-transparent",
              own?.gap ? "border-r-status-waiting" : "border-r-status-failed",
            )}
          />
        </span>,
      );
    if (own?.starts && own.mark.provider && start >= props.firstRow)
      drawn.push(
        <span
          key={`who-${line}`}
          data-agent-mark={own.mark.provider}
          title={own.mark.label}
          className="pointer-events-auto absolute grid place-items-center"
          style={{
            left: props.scrollLeft + 4,
            top: start * lineHeight,
            width: iconSize + 2,
            height: lineHeight,
          }}
        >
          <ProviderIcon provider={own.mark.provider} size={iconSize} decorative />
        </span>,
      );
  }
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[2]">
      {drawn}
    </div>
  );
}
