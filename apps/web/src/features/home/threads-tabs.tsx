import { tabThreads, threadsTabs, type ThreadsPanel, type ThreadsTab } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { KeymapId } from "@/lib/keymap.ts";

const shortcuts: Record<ThreadsTab, KeymapId> = {
  inbox: "showInbox",
  snoozed: "showSnoozed",
  settled: "showSettled",
};

/**
 * The Threads panel's three places as text tabs under its title row: Inbox, Snoozed and Settled,
 * the open one on the `--active` fill in foreground ink, the others subtle. Inbox and Snoozed
 * carry a quiet count after the word (none at zero); Settled has none. ← and → move between
 * them, as 1, 2 and 3 do from anywhere in the panel, and ⌃1–3 (the keymap's Threads shortcuts)
 * from anywhere in the app.
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
  const counts: Record<ThreadsTab, number> = {
    inbox: tabThreads(props.panel, "inbox").length,
    snoozed: tabThreads(props.panel, "snoozed").length,
    settled: 0,
  };
  return (
    <div
      role="tablist"
      aria-label="Projects"
      data-part="sidebar-tabs"
      className="flex h-9 shrink-0 items-center gap-0.5 px-2"
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
        const count = counts[id];
        return (
          <Tip key={id} label={label} shortcut={shortcuts[id]} side="bottom">
            <button
              type="button"
              role="tab"
              aria-selected={current}
              data-part="tab"
              data-state={current ? "selected" : undefined}
              tabIndex={current ? 0 : -1}
              aria-label={count ? `${label}, ${count}` : label}
              onClick={() => props.onTab(id)}
              className={cn(
                "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-meta font-medium transition-colors duration-(--motion-fast) focus-ring-inset",
                current ? "bg-active text-foreground" : "text-subtle-foreground hover:text-foreground",
              )}
            >
              {label}
              {count > 0 && (
                <span className="text-xs font-normal text-subtle-foreground tabular-nums">
                  {count}
                </span>
              )}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}
