import { formatAgo } from "@ace/ui-core";
import type { ForgePrStatus } from "@ace/protocol";
import { CheckCircleIcon, CircleIcon, WarningCircleIcon, ClockIcon } from "@phosphor-icons/react";
import { useNow } from "@/lib/time.ts";
import { MessageAvatar } from "@/components/ui/message.tsx";

export function PrAvatar(props: { name: string; url?: string | undefined }) {
  const url = props.url?.startsWith("https://") ? props.url : undefined;
  return (
    <MessageAvatar className="size-6 min-w-6 self-center">
      {url ? (
        <img
          src={url}
          alt={props.name}
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span aria-label={props.name} className="text-xs">
          {props.name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </MessageAvatar>
  );
}
export function PrTime(props: { at?: string | null | undefined; prefix?: string }) {
  const now = useNow();
  const at = props.at ? Date.parse(props.at) : NaN;
  return (
    <time
      dateTime={props.at ?? undefined}
      title={props.at ?? undefined}
      className="text-sm text-muted-foreground"
    >
      {props.prefix}
      {Number.isFinite(at) ? formatAgo(at, now) : "Time unavailable"}
    </time>
  );
}
export function checkSummary(status: Pick<ForgePrStatus, "ci" | "checks">): string {
  const failures = status.checks.filter((c) => c.status === "failure").length;
  if (failures) return `${failures} failing`;
  if (status.ci === "failure") return "Checks failing";
  if (status.ci === "pending") return "Checks running";
  if (status.ci === "success") return "All checks passed";
  if (status.ci === "none") return "No checks reported";
  return "Checks unavailable";
}
export function PrChecksPill(props: { ci: ForgePrStatus["ci"]; checks?: ForgePrStatus["checks"] }) {
  const Icon =
    props.ci === "success"
      ? CheckCircleIcon
      : props.ci === "failure"
        ? WarningCircleIcon
        : props.ci === "pending"
          ? ClockIcon
          : CircleIcon;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon aria-hidden size={16} />
      {checkSummary({ ci: props.ci, checks: props.checks ?? [] })}
    </span>
  );
}
