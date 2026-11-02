import { rowIndicator, rowStatusLook, type RowAttention, type ThreadCard } from "@ace/ui-core";
import { LookIcon } from "./row-parts.tsx";

/**
 * A sidebar row's one mark at its right edge: the same icon, in the same colour, as its
 * three-line row shows (`rowStatusLook`), still and silent. Only what asks the person to look (a
 * request, a fresh failure, unread finished work) or still works or waits shows one; a thread at
 * rest, a seen failure and an unconfirmed copy show nothing, as `rowIndicator` says. The row's
 * spoken name already says its status, so the mark itself is silent.
 */
export function RowIndicator(props: { attention: RowAttention; card: ThreadCard }) {
  if (!rowIndicator(props.attention)) return null;
  return <LookIcon look={rowStatusLook(props.attention, props.card)} />;
}
