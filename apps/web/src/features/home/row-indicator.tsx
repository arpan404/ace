import { rowIndicator, rowStatusLook, type RowAttention, type ThreadCard } from "@ace/ui-core";
import { StatusIcon } from "@/components/status-icons.tsx";

/**
 * A sidebar row's one mark at its right edge: the same solid icon its three-line row shows
 * (`rowStatusLook`), still and silent. Only what asks the person to look (a request, a fresh
 * failure, unread finished work) or still works or waits shows one; a thread at rest, a seen
 * failure and an unconfirmed copy show nothing, as `rowIndicator` says. The row's spoken name
 * already says its status, so the mark itself is silent.
 */
export function RowIndicator(props: { attention: RowAttention; card: ThreadCard }) {
  if (!rowIndicator(props.attention)) return null;
  const look = rowStatusLook(props.attention, props.card);
  if (look.icon === "none") return null;
  return (
    <span
      aria-hidden
      data-icon={look.icon}
      data-tone={look.tone}
      className="inline-flex text-(--tone)"
    >
      <StatusIcon kind={look.icon} size={14} />
    </span>
  );
}
