import { chatDayLabels, type HomeRow } from "@ace/ui-core";
import { panelLabel, panelLabelGap } from "@/components/ui/panel.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * The rows of the panel's lists that aren't threads: Settled's last row, which points to search
 * for older settled threads, a list's empty line, and the Chats panel's Active and day labels.
 * A label (`panelLabel`) leaves 20px above it.
 */

/** Settled's foot while the daemon holds older settled threads back: search reaches them. */
function OlderInSearch() {
  return (
    <p className="flex items-center gap-1.5 px-3 py-3 text-meta text-subtle-foreground">
      Older settled threads are in search
      <Kbd shortcut="palette" />
    </p>
  );
}

/** One section row; nothing for a thread row, which the list draws itself. */
export function SectionRow(props: { row: HomeRow; first: boolean }) {
  const { row } = props;
  switch (row.kind) {
    case "active-label":
      return (
        <div role="heading" aria-level={3} className={cn(panelLabel, panelLabelGap(props.first))}>
          Active
        </div>
      );
    case "older":
      return <OlderInSearch />;
    case "empty":
      return <p className="py-2 pr-2.5 pl-9 text-ui text-subtle-foreground">{row.text}</p>;
    case "day-label":
      return (
        <div role="heading" aria-level={3} className={cn(panelLabel, panelLabelGap(props.first))}>
          {chatDayLabels[row.day]}
        </div>
      );
    default:
      return null;
  }
}
