import { spadePastTime, type SpadeDecision } from "@ace/ui-core/spade-chat";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import { personZone } from "./spade-routines-api.ts";

/* The choices the bot made for the person (ADR 0165), with each one's reason. */

/**
 * A row's end: its quiet fact, traded on hover or focus for its action in the same place. On a
 * touch screen, with no hover, both show side by side.
 */
const swap =
  "grid shrink-0 items-center justify-items-end [&>*]:[grid-area:1/1] pointer-coarse:flex pointer-coarse:gap-2";
/** The quiet fact, gone while the action shows. */
const revealedAway =
  "group-hover/row:invisible group-focus-within/row:invisible pointer-coarse:visible";
/** The action: there on hover or focus, and reachable by keyboard always. */
const revealed =
  "text-foreground opacity-0 focus-ring transition-opacity duration-(--motion-fast) group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:bg-active";

/** Each choice the bot made for the person, with its reason; Change quotes it into the composer. */
export function WorkDecisions(props: {
  decisions: readonly SpadeDecision[];
  onChange(decision: SpadeDecision): void;
}) {
  const now = useNow();
  if (!props.decisions.length) return null;
  const zone = personZone();
  return (
    <ProfileSection label="Decided for you">
      {props.decisions.map((decision) => (
        <div key={decision.id} className="group/row flex items-start gap-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-ui leading-5 text-foreground">{decision.choice}</p>
            {decision.reason && (
              <p className="text-xs leading-4 text-muted-foreground">{decision.reason}</p>
            )}
          </div>
          <div className={swap}>
            <span
              className={cn("text-xs leading-5 text-subtle-foreground tabular-nums", revealedAway)}
            >
              {spadePastTime(decision.at, { now, timeZone: zone })}
            </span>
            <button
              type="button"
              aria-label={`Change: ${decision.choice}`}
              onClick={() => props.onChange(decision)}
              className={cn(rowPill, "-my-1 -mr-2 h-7 text-ui font-medium", revealed)}
            >
              Change
            </button>
          </div>
        </div>
      ))}
    </ProfileSection>
  );
}
