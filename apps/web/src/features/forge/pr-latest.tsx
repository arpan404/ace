import type { ForgePrDetail } from "@ace/protocol";
import { PrTime } from "./pr-presentation.tsx";
import { latestEvents } from "./pr-summary-model.ts";
import { SectionAction, SummarySection } from "./pr-summary-section.tsx";

const shown = 4;

/**
 * The newest few things that happened (verdicts, comments, failed checks) as one line each,
 * with the Timeline a word away. With nothing yet, it says so and offers to start the
 * conversation.
 */
export function PrLatest(props: { detail: ForgePrDetail; onTimeline(): void }) {
  const events = latestEvents(props.detail.status, shown);
  return (
    <SummarySection
      title="Latest"
      right={
        <SectionAction onClick={props.onTimeline}>
          {events.length ? "Timeline" : "Leave a comment"}
        </SectionAction>
      }
    >
      {events.length ? (
        <ul>
          {events.map((event) => (
            <li
              key={event.key}
              className="flex min-h-8 items-baseline gap-3 py-1 text-ui text-muted-foreground"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium text-foreground">{event.who}</span> {event.what}
                {event.where && (
                  <span className="font-mono text-xs text-foreground/85"> {event.where}</span>
                )}
              </span>
              <span className="shrink-0 text-xs text-subtle-foreground">
                <PrTime at={event.at} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ui text-subtle-foreground">Nothing yet.</p>
      )}
    </SummarySection>
  );
}
