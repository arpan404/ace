import { CheckCircleIcon, ClockIcon, TrayIcon } from "@phosphor-icons/react";
import { tabThreads, threadsTabs, type ThreadsPanel, type ThreadsTab } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";

/**
 * The Threads panel's three places as a floating pill in its bottom-right: Inbox, Snoozed and
 * Settled as icon-only tabs. The open one takes the `--active` fill; the rest are muted with
 * `--hover` on hover. Counts live in the tooltips and accessible names, never as visible text.
 * ← and → move between them, as 1, 2 and 3 do from anywhere in the panel.
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
  const inboxCount = tabThreads(props.panel, "inbox").length;
  const snoozedCount = tabThreads(props.panel, "snoozed").length;
  const settledCount = tabThreads(props.panel, "settled").length;
  const icons = {
    inbox: TrayIcon,
    snoozed: ClockIcon,
    settled: CheckCircleIcon,
  } as const;
  const tips: Record<ThreadsTab, string> = {
    inbox: `Inbox · ${inboxCount} · 1`,
    snoozed: "Snoozed · 2",
    settled: "Settled · 3",
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
      className="ace-floating absolute right-3 bottom-3 z-10 flex gap-0.5 rounded-full border border-border bg-popover p-[3px] text-popover-foreground shadow-glass"
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
      {threadsTabs.map(({ id }) => {
        const current = id === props.tab;
        const showDot = id === "inbox" && !current && props.needsYou.length > 0;
        return (
          <Tip key={id} label={tips[id]} side="top">
            <button
              type="button"
              role="tab"
              aria-selected={current}
              tabIndex={current ? 0 : -1}
              aria-label={labels[id]}
              onClick={() => props.onTab(id)}
              className={cn(
                "relative grid size-7 place-items-center rounded-full transition-colors duration-(--motion-fast) focus-ring",
                current
                  ? "bg-active text-foreground"
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
