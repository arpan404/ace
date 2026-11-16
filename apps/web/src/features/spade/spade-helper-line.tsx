import { formatElapsed } from "@ace/ui-core/time";
import { useSeconds } from "@/lib/time.ts";

/**
 * A helper the bot started (ADR 0152): one plain line in Spade's words ("Helper looking into: …",
 * "Helper found: …", "Helper stopped"), with how long it has been at it while it works. Words
 * only: no icon, no badge, and no list of its steps.
 */
export function SpadeHelperLine(props: {
  text: string;
  /** Still working. */
  open: boolean;
  /** When it started, for its running time while it works; undefined when unknown. */
  since?: number | undefined;
}) {
  const timed = props.open && props.since !== undefined;
  const now = useSeconds(timed);
  return (
    <p
      role="note"
      className="ml-1.5 flex h-7 min-w-0 items-center gap-1.5 px-2 text-ui text-muted-foreground"
    >
      <span className="min-w-0 truncate">{props.text}</span>
      {timed && props.since !== undefined && (
        <span className="shrink-0 text-subtle-foreground tabular-nums">
          {formatElapsed(now - props.since)}
        </span>
      )}
    </p>
  );
}
