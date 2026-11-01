import { rowIndicator, type RowAttention } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/**
 * A sidebar row's one mark at its right edge (`rowIndicator`): a dot for what asks the person to
 * look (needs you, a fresh failure, unread finished work), a ring that breathes a few times
 * while the thread's tree still works or waits. The row's spoken name already says its status,
 * so the mark itself is silent.
 */
export function RowIndicator(props: { attention: RowAttention }) {
  const mark = rowIndicator(props.attention);
  if (!mark) return null;
  return (
    <span
      aria-hidden
      data-indicator={mark.kind}
      data-tone={mark.tone}
      className={cn(
        "size-2 shrink-0 rounded-full",
        mark.kind === "live" ? "fx-live-dot shadow-[inset_0_0_0_1.5px_var(--tone)]" : "bg-(--tone)",
      )}
    />
  );
}
