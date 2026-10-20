import { sectionRule } from "@/components/ui/rules.ts";
import { StaticRow, TranscriptRow } from "./transcript-row.tsx";

/** A hairline under the "Worked for" line, parting the turn's work from its answer. */
const underline = `mt-1.5 ${sectionRule}`;

/*
 * A settled work log's header; `work-log.tsx` binds it to the thread. Its steps load when it
 * opens (`turn-work.tsx`): logs start folded.
 */

/** "Worked for 1m 43s" as a plain row; the turn's time lives with its answer. */
export function WorkLogHeader(props: {
  label: string;
  open: boolean;
  panel: string;
  onToggle(): void;
  /** The pointer reached the line or focus did: it may open next. */
  onIntent?: (() => void) | undefined;
}) {
  return (
    <div onPointerEnter={props.onIntent} onFocus={props.onIntent}>
      <TranscriptRow
        expanded={props.open}
        controls={props.panel}
        onToggle={props.onToggle}
        title={props.label}
      />
      <div aria-hidden className={underline} />
    </div>
  );
}

/** "Worked for 1s" with nothing to open: the same line as the header, as plain text. */
export function WorkLogLine(props: { label: string }) {
  return (
    <div>
      <StaticRow title={props.label} />
      <div aria-hidden className={underline} />
    </div>
  );
}

/** Rows standing in for a log's steps while they load. */
export function StepsSkeleton() {
  return (
    <div role="status" aria-label="Loading steps" className="flex flex-col gap-2 py-1.5 pl-1.5">
      {[62, 48, 70].map((width) => (
        <div key={width} className="flex h-4 items-center gap-2">
          <span className="fx-skeleton size-3.5 shrink-0 rounded-sm" />
          <span className="fx-skeleton h-3" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}
