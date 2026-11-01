import { tabThreads, threadsTabs, type ThreadsPanel, type ThreadsTab } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/**
 * The Threads panel's three places under its title: Inbox, Snoozed and Settled, as text tabs.
 * The open one takes the `--active` fill; Inbox and Snoozed carry a quiet count. ← and → move
 * between them, as 1, 2 and 3 do from anywhere in the panel.
 */
export function ThreadsTabs(props: {
  tab: ThreadsTab;
  panel: ThreadsPanel;
  onTab(tab: ThreadsTab): void;
}) {
  const step = (by: number) => {
    const at = threadsTabs.findIndex((each) => each.id === props.tab);
    const next = threadsTabs[(at + by + threadsTabs.length) % threadsTabs.length];
    if (next) props.onTab(next.id);
  };
  return (
    <div
      role="tablist"
      aria-label="Threads"
      className="flex shrink-0 items-center gap-0.5 px-3 pt-0.5 pb-1.5"
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
      {threadsTabs.map(({ id, label }) => {
        const current = id === props.tab;
        const count = id === "settled" ? undefined : tabThreads(props.panel, id).length;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={current}
            tabIndex={current ? 0 : -1}
            aria-label={count === undefined ? label : `${label}, ${count}`}
            onClick={() => props.onTab(id)}
            className={cn(
              "inline-flex h-7 items-baseline gap-1.5 rounded-md px-2.5 pt-1.5 text-meta font-medium transition-colors duration-(--motion-fast) focus-ring",
              current
                ? "bg-active text-foreground"
                : "text-subtle-foreground hover:text-foreground",
            )}
          >
            {label}
            {count !== undefined && count > 0 && (
              <span aria-hidden className="text-xs font-normal text-subtle-foreground tabular-nums">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
