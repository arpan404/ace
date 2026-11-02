import { rowIndicator, rowStatusLook, type RowAttention, type ThreadCard } from "@ace/ui-core";
import { StatusIcon } from "@/components/status-icons.tsx";

/**
 * A sidebar row's one mark at its right edge: the same solid icon its three-line row shows
 * (`rowStatusLook`), still and silent. Only what asks the person to look (a request, a fresh
 * failure) is coloured; work that still works or waits draws its icon in grey; unread finished
 * work is marked by its bold title instead; a thread at rest, a seen failure and an unconfirmed
 * copy show nothing, as `rowIndicator` says. The row's spoken name
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
      data-ink={look.ink}
      className={
        look.ink === "muted" ? "inline-flex text-muted-foreground" : "inline-flex text-(--tone)"
      }
    >
      <StatusIcon kind={look.icon} size={14} />
    </span>
  );
}
