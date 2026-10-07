import type { InteractionMeasurement } from "@ace/protocol";
import { measurementTimeline } from "@ace/ui-core/interaction-measurement";

/**
 * The recorded window as a thin strip: the span the content was changing, each hitch as a mark
 * as wide as it lasted, and a tick where it settled. The strip reads as one sentence to
 * assistive tech, followed by the hitches as a list.
 */
export function MeasurementTimeline(props: { measurement: InteractionMeasurement }) {
  const timeline = measurementTimeline(props.measurement);
  const { span, hitches, settle } = timeline;
  // Hitches read as failure only in a janky run; elsewhere they are worth a look, no more.
  const hitchTone = props.measurement.verdict === "janky" ? "failed" : "needs-you";
  return (
    <div className="flex flex-col gap-1">
      <div
        role="img"
        aria-label={timeline.text}
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        {span && (
          <span
            className="absolute inset-y-0 bg-subtle-foreground opacity-40"
            style={{ left: `${span.from}%`, width: `${span.to - span.from}%` }}
          />
        )}
        {hitches.map((hitch) => (
          <span
            key={hitch.text}
            data-tone={hitchTone}
            className="absolute inset-y-0 bg-(--tone)"
            style={{ left: `${hitch.at}%`, width: `max(2px, ${hitch.width}%)` }}
          />
        ))}
        {settle !== undefined && (
          <span
            data-tone="done"
            className="absolute inset-y-0 w-0.5 bg-(--tone)"
            style={{ left: `${settle}%` }}
          />
        )}
      </div>
      <div
        aria-hidden
        className="flex justify-between font-mono text-xs text-subtle-foreground tabular-nums"
      >
        <span>{timeline.ticks.start}</span>
        <span>{timeline.ticks.end}</span>
      </div>
      {hitches.length > 0 && (
        <ul aria-label="Hitches" className="sr-only">
          {hitches.map((hitch) => (
            <li key={hitch.text}>{hitch.text}</li>
          ))}
          {timeline.unlisted && <li>More hitches than listed, counted in the hitching time</li>}
        </ul>
      )}
    </div>
  );
}
