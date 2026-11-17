import { eventSnoozeBackstopMs, snoozePresets } from "@ace/ui-core";
import { usageFailure } from "../output.ts";

export interface SnoozeChoice {
  readonly until: number;
  readonly wake?: "needs_you" | "pr";
}

const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `--until` for `ace thread snooze`: a span (`30m`, `1h`, `2d`), the app's presets (`tomorrow`
 * and `monday` at 9:00 local time) or an event (`needs-you`, `pr-changes`), which still wakes
 * after 30 days if the event never comes, as the app's menu does. Pure: the caller gives now.
 */
export function snoozeUntil(value: string, now: number): SnoozeChoice {
  const word = value.trim().toLowerCase();
  const span = /^(\d{1,4})([mhd])$/.exec(word);
  if (span) {
    const amount = Number(span[1]);
    const unit = units[span[2] ?? ""] ?? 0;
    if (amount > 0) return { until: now + amount * unit };
  }
  const presets = snoozePresets(now);
  const preset = presets.find((each) => each.id === (word === "next-monday" ? "monday" : word));
  if (preset) return { until: preset.until };
  if (word === "needs-you") return { until: now + eventSnoozeBackstopMs, wake: "needs_you" };
  if (word === "pr-changes" || word === "pr")
    return { until: now + eventSnoozeBackstopMs, wake: "pr" };
  throw usageFailure(
    `--until takes a time like 1h, tomorrow, monday, needs-you or pr-changes, not ${value}.`,
    {
      argument: "--until",
    },
  );
}
