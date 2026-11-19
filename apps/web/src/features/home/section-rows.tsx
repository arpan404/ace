import { chatDayLabels, type HomeRow } from "@ace/ui-core";
import { use } from "react";
import { panelLabel, panelLabelGap } from "@/components/ui/panel.tsx";
import { cn } from "@/lib/cn.ts";
import { PanelPagingContext } from "./use-panel-rows.ts";

/*
 * The rows of the panel's lists that aren't threads: Snoozed's and Settled's last row (the
 * next page as it loads, or Show more), a list's empty line, and the Chats panel's Active and day labels.
 * A label (`panelLabel`) leaves 20px above it.
 */

const footButton =
  "cursor-pointer rounded-md px-1.5 py-0.5 text-meta font-medium text-muted-foreground hover:bg-hover hover:text-foreground focus-ring-inset focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent";

/**
 * Snoozed's or Settled's foot while more are left. The next page follows as it scrolls into view;
 * Show more asks for it by hand (and retries a failed one), for a list too short to scroll.
 */
function MoreRow() {
  const paging = use(PanelPagingContext);
  return (
    <div className="flex items-center gap-1 px-1.5 py-2">
      <button
        type="button"
        data-section-toggle=""
        disabled={paging.loading}
        onClick={paging.more}
        className={footButton}
      >
        {paging.loading ? "Loading…" : paging.error ? "Couldn't load. Try again" : "Show more"}
      </button>
    </div>
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
    case "more":
      return <MoreRow />;
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
