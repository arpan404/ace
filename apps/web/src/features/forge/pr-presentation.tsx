import { ciLine, formatAgo } from "@ace/ui-core";
import type { ForgePrStatus } from "@ace/protocol";
import { CheckCircleIcon, CircleIcon, WarningCircleIcon, ClockIcon } from "@phosphor-icons/react";
import { useNow } from "@/lib/time.ts";
import { MessageAvatar } from "@/components/ui/message.tsx";

export function PrAvatar(props: { name: string; url?: string | undefined }) {
  const url = props.url?.startsWith("https://") ? props.url : undefined;
  return (
    <MessageAvatar className="size-5 min-w-5 self-center">
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
      className="text-xs text-muted-foreground"
    >
      {props.prefix}
      {Number.isFinite(at) ? formatAgo(at, now) : "Time unavailable"}
    </time>
  );
}
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
