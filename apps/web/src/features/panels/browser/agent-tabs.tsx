import { addressHost } from "@ace/ui-core";
import { GlobeSimpleIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { Dot } from "@/components/ui/dot.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { BrowserTabView, BrowserView } from "../sources.ts";
import type { BrowserFeatures } from "./use-browser-features.ts";

const tabName = (tab: BrowserTabView) =>
  tab.title.trim() || addressHost(tab.url) || (tab.url === "about:blank" ? "New tab" : tab.url);

/**
 * A page's mark: the first letter of its site on a small tile, or a globe for a page without
 * one. Drawn locally: fetching a favicon would reach the site outside the daemon's origin policy.
 */
function SiteGlyph(props: { url: string; className?: string | undefined }) {
  const letter = addressHost(props.url)
    ?.replace(/^www\./, "")
    .charAt(0)
    .toUpperCase();
  if (!letter)
    return <GlobeSimpleIcon aria-hidden size={16} className={cn("shrink-0", props.className)} />;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-xs bg-foreground/10 text-2xs leading-none font-semibold",
        props.className,
      )}
    >
      {letter}
    </span>
  );
}

/**
 * The agent's tabs in this thread's browser as pills, each with its site's mark: switch to one or
 * close it (its close button takes the mark's place on hover). Tabs keep the daemon's stable ids
 * (two tabs on one address stay two); a tab with a question waiting carries a dot. Opening,
 * switching and closing take control from the agent first, as the daemon requires.
 */
export function AgentTabs(props: { view: BrowserView; browser: BrowserFeatures; busy: boolean }) {
  const tabs = props.view.tabs ?? [];
  if (!tabs.length) return null;
  const agentDrives = props.view.controller === "agent";
  // The last tab can't be closed: the page lives in it.
  const closable = tabs.length > 1;
  return (
    <div className="flex min-w-24 flex-1 items-center gap-0.5">
      <div
        role="tablist"
        aria-label="Agent tabs"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.tabId === props.view.activeTabId;
          const name = tabName(tab);
          return (
            <div
              key={tab.tabId}
              className={cn(
                "group relative flex h-7 max-w-48 min-w-8 items-center rounded-md text-xs transition-colors duration-(--dur-1)",
                active
                  ? "bg-foreground/8 text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Tip
                label={agentDrives && !active ? `${tab.url} · switching takes control` : tab.url}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={props.busy}
                  onClick={() => !active && void props.browser.switchTab(tab.tabId)}
                  className="flex h-full min-w-0 items-center gap-1.5 rounded-md pr-2 pl-1.5 focus-ring"
                >
                  {/* With more than one tab, its close button takes the mark's place on hover. */}
                  <SiteGlyph
                    url={tab.url}
                    className={
                      closable ? "group-hover:opacity-0 pointer-coarse:opacity-0" : undefined
                    }
                  />
                  <span className="truncate">{name}</span>
                  {tab.pendingDialog && <Dot tone="needs-you" />}
                </button>
              </Tip>
              {closable && (
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  disabled={props.busy}
                  onClick={() => void props.browser.closeTab(tab.tabId)}
                  className="absolute ml-1 grid size-5 place-items-center rounded-sm bg-background text-muted-foreground opacity-0 focus-ring group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
                >
                  <XIcon aria-hidden size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <Tip label="New tab">
        <button
          type="button"
          aria-label="New page tab"
          disabled={props.busy || tabs.length >= 8}
          onClick={() => void props.browser.openTab()}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground focus-ring hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <PlusIcon aria-hidden size={14} />
        </button>
      </Tip>
    </div>
  );
}
