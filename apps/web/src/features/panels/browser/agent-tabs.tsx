import { addressHost } from "@ace/ui-core";
import { XIcon, PlusIcon } from "@phosphor-icons/react";
import { Dot } from "@/components/ui/dot.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { BrowserTabView, BrowserView } from "../sources.ts";
import type { BrowserFeatures } from "./use-browser-features.ts";

const tabName = (tab: BrowserTabView) =>
  tab.title.trim() || addressHost(tab.url) || (tab.url === "about:blank" ? "New tab" : tab.url);

/**
 * The agent's tabs in this thread's browser: switch to one or close it. Tabs keep the daemon's
 * stable ids (two tabs on one address stay two); a tab with a question waiting carries a dot.
 * Opening, switching and closing take control from the agent first, as the daemon requires.
 */
export function AgentTabs(props: { view: BrowserView; browser: BrowserFeatures; busy: boolean }) {
  const tabs = props.view.tabs ?? [];
  if (!tabs.length) return null;
  const agentDrives = props.view.controller === "agent";
  return (
    <div
      role="tablist"
      aria-label="Agent tabs"
      className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5"
    >
      {tabs.map((tab) => {
        const active = tab.tabId === props.view.activeTabId;
        const name = tabName(tab);
        return (
          <div
            key={tab.tabId}
            className={cn(
              "group flex h-6 max-w-48 min-w-0 shrink-0 items-center rounded-sm text-xs",
              active
                ? "bg-foreground/8 text-foreground"
                : "text-muted-foreground hover:bg-foreground/5",
            )}
          >
            <Tip label={agentDrives && !active ? `${tab.url} · switching takes control` : tab.url}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                disabled={props.busy}
                onClick={() => !active && void props.browser.switchTab(tab.tabId)}
                className="flex h-full min-w-0 items-center gap-1.5 rounded-sm pr-1 pl-2 focus-ring"
              >
                {tab.pendingDialog && <Dot tone="needs-you" />}
                <span className="truncate">{name}</span>
              </button>
            </Tip>
            <button
              type="button"
              aria-label={`Close ${name}`}
              disabled={props.busy || tabs.length === 1}
              onClick={() => void props.browser.closeTab(tab.tabId)}
              className={cn(
                "mr-0.5 grid size-5 shrink-0 place-items-center rounded-xs text-subtle-foreground focus-ring hover:bg-foreground/8 hover:text-foreground",
                !active &&
                  "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
              )}
            >
              <XIcon aria-hidden size={11} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New page tab"
        disabled={props.busy || tabs.length >= 8}
        onClick={() => void props.browser.openTab()}
        className="grid size-6 shrink-0 place-items-center rounded-sm focus-ring hover:bg-accent"
      >
        <PlusIcon aria-hidden size={12} />
      </button>
    </div>
  );
}
