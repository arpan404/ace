import { CheckCircleIcon, ClockIcon, TrayIcon } from "@phosphor-icons/react";
import { tabThreads, threadsTabs, type ThreadsPanel, type ThreadsTab } from "@ace/ui-core";
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { KeymapId } from "@/lib/keymap.ts";
import "./threads-tabs.css";

/**
 * The Threads panel's three places as a floating pill in its bottom-right: Inbox, Snoozed and
 * Settled as icon-only tabs over the scrolling rows. The pill is the shared floating material
 * (translucent over the list, opaque under Solid or reduced transparency); one selection thumb
 * slides behind the buttons, the open icon in foreground ink, the rest muted. Counts live in
 * the tooltips and accessible names, never as visible text. ← and → move between them, as 1,
 * 2 and 3 do from anywhere in the panel, and ⌃1–3 (the keymap's Threads shortcuts) from
 * anywhere in the app.
 */
export function ThreadsTabs(props: {
  tab: ThreadsTab;
  panel: ThreadsPanel;
  /** Threads in the Inbox that need the person, for the Inbox dot (`useHomeList`). */
  needsYou: readonly string[];
  onTab(tab: ThreadsTab): void;
}) {
  const step = (by: number) => {
    const at = threadsTabs.findIndex((each) => each.id === props.tab);
    const next = threadsTabs[(at + by + threadsTabs.length) % threadsTabs.length];
    if (next) props.onTab(next.id);
  };
  const index = Math.max(
    0,
    threadsTabs.findIndex((each) => each.id === props.tab),
  );
  const inboxCount = tabThreads(props.panel, "inbox").length;
  const snoozedCount = tabThreads(props.panel, "snoozed").length;
  const settledCount = tabThreads(props.panel, "settled").length;
  const icons = {
    inbox: TrayIcon,
    snoozed: ClockIcon,
    settled: CheckCircleIcon,
  } as const;
  const tips: Record<ThreadsTab, string> = {
    inbox: `Inbox · ${inboxCount}`,
    snoozed: "Snoozed",
    settled: "Settled",
  };
  const shortcuts: Record<ThreadsTab, KeymapId> = {
    inbox: "showInbox",
    snoozed: "showSnoozed",
    settled: "showSettled",
  };
  const labels: Record<ThreadsTab, string> = {
    inbox: `Inbox, ${inboxCount}`,
    snoozed: `Snoozed, ${snoozedCount}`,
    settled: `Settled, ${settledCount}`,
  };
  return (
    <div
      role="tablist"
      aria-label="Threads"
      className="ace-floating threads-tabs-mount absolute right-3 bottom-3 z-10 flex items-center gap-1 rounded-full p-1"
      onKeyDown={(event) => {
        const by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!by) return;
        event.preventDefault();
        step(by);
        // Focus follows the open tab, as the arrows promise.
        requestAnimationFrame(() =>
          event.currentTarget
            .querySelector<HTMLElement>("[aria-selected=true]")
            ?.focus({ preventScroll: true }),
        );
      }}
    >
      <span
        aria-hidden
        data-selected-index={index}
        style={{ "--i": index } as CSSProperties}
        className="threads-tabs-thumb absolute top-1 left-1 size-7 rounded-full bg-active"
      />
      {threadsTabs.map(({ id }) => {
        const current = id === props.tab;
        const showDot = id === "inbox" && !current && props.needsYou.length > 0;
        return (
          <Tip key={id} label={tips[id]} shortcut={shortcuts[id]} side="top">
            <button
              type="button"
              role="tab"
              aria-selected={current}
              tabIndex={current ? 0 : -1}
              aria-label={labels[id]}
              onClick={() => props.onTab(id)}
              className={cn(
                "threads-tabs-tab relative grid size-7 cursor-pointer place-items-center rounded-full focus-ring-inset active:scale-[0.96]",
                current
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-hover hover:text-foreground",
              )}
            >
              <Icon icon={icons[id]} size={16} active={current} />
              {showDot && (
                <span
                  aria-hidden
                  data-tone="needs-you"
                  className="absolute top-[3px] right-[3px] size-1.5 rounded-full bg-(--tone) ring-1 ring-popover"
                />
              )}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}
