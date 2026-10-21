import { ciLine } from "@ace/ui-core";
import type { ForgePrStatus } from "@ace/protocol";
import { CheckCircleIcon, CircleIcon, WarningCircleIcon, ClockIcon } from "@phosphor-icons/react";

/** The PR view's names for the shared avatar and relative time. */
export { PersonAvatar as PrAvatar, RelativeTime as PrTime } from "@/components/person-avatar.tsx";
/** The checks in one line, worded as the thread's work card words them (`ciLine`). */
export function PrChecksPill(props: { status: Pick<ForgePrStatus, "ci" | "checks"> }) {
  const line = ciLine(props.status);
  const Icon =
    line.tone === "success"
      ? CheckCircleIcon
      : line.tone === "failure"
        ? WarningCircleIcon
        : line.tone === "pending"
          ? ClockIcon
          : CircleIcon;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon aria-hidden size={14} />
      {line.text}
    </span>
  );
}
