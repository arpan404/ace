import { useAgent } from "@ace/client-react";
import { agentName } from "@ace/ui-core";
import {
  EyeSlashIcon,
  GlobeSimpleIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
} from "@phosphor-icons/react";
import { AgentCursorIcon } from "@/components/ace-icons.tsx";
import { useCallback, useSyncExternalStore } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { WorkspaceTab } from "@/lib/workspace/index.ts";
import { useLoadedServices } from "../services.ts";
import { useLocal } from "../store.ts";
import type { BrowserTabView, PreviewSource } from "../sources.ts";
import { daemonTabId } from "./browser-data.ts";
import { loadingKey, loadingTabs } from "./loading.ts";

/** The daemon's tab behind a panel tab, re-read whenever the thread's browser changes. */
function useDaemonTab(
  source: PreviewSource | undefined,
  threadId: string,
  tabId: string | undefined,
): BrowserTabView | undefined {
  const subscribe = useCallback(
    (changed: () => void) => source?.subscribe(changed, threadId) ?? (() => {}),
    [source, threadId],
  );
  const read = useCallback(
    () => (tabId ? source?.view(threadId)?.tabs?.find((tab) => tab.tabId === tabId) : undefined),
    [source, threadId, tabId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * What leads a browser panel tab, from the daemon's tab: the agent cursor (in the person's accent)
 * colour, pulsing, while an agent uses it (its name in the tooltip), a spinner while the page loads, else
 * the site's favicon, else a globe.
 */
export function BrowserTabMark(props: { scope: string; tab: WorkspaceTab; className?: string }) {
  const source = useLoadedServices()?.preview;
  const tab = useDaemonTab(source, props.scope, daemonTabId(props.tab));
  const key = loadingKey(props.scope, props.tab.key);
  const navigating = useLocal(
    loadingTabs,
    useCallback((tabs: ReadonlySet<string>) => tabs.has(key), [key]),
  );
  const agent = useAgent(props.scope, tab?.inUse?.agentId ?? "");
  const box = cn("grid size-4 shrink-0 place-items-center", props.className);
  if (tab?.inUse) {
    const worker = agent ? agentName(agent) : "An agent";
    return (
      <Tip label={`${worker} is using this tab`}>
        <span
          role="img"
          aria-label={`${worker} is using this tab`}
          // The tab's title pulses in step with the cursor (styles/motion.css).
          data-agent-driving=""
          className={cn(box, "fx-agent-pulse")}
        >
          <AgentCursorIcon aria-hidden size={16} />
        </span>
      </Tip>
    );
  }
  if (tab?.loading || navigating)
    return (
      <span className={box}>
        <Spinner label="Loading" className="size-3.5" />
      </span>
    );
  if (tab?.favicon)
    return (
      <span className={box}>
        <img
          src={tab.favicon}
          alt=""
          aria-hidden
          data-favicon=""
          draggable={false}
          className="size-4 rounded-xs"
        />
      </span>
    );
  return (
    <span className={box}>
      <GlobeSimpleIcon aria-hidden size={14} />
    </span>
  );
}

/** After the title: the tab plays sound (or is muted while it would), and agents kept out. */
export function BrowserTabBadge(props: { scope: string; tab: WorkspaceTab; folded?: boolean }) {
  const source = useLoadedServices()?.preview;
  const tab = useDaemonTab(source, props.scope, daemonTabId(props.tab));
  if (props.folded || !tab) return null;
  const sound = tab.audible === true;
  if (!tab.private && !sound) return null;
  return (
    <>
      {sound &&
        (tab.muted ? (
          <SpeakerSlashIcon
            role="img"
            aria-label="Muted"
            size={12}
            className="ml-0.5 shrink-0 text-subtle-foreground"
          />
        ) : (
          <SpeakerHighIcon
            role="img"
            aria-label="Playing sound"
            size={12}
            className="ml-0.5 shrink-0 text-subtle-foreground"
          />
        ))}
      {tab.private && (
        <EyeSlashIcon
          role="img"
          aria-label="Agents kept out"
          size={12}
          className="ml-0.5 shrink-0 text-subtle-foreground"
        />
      )}
    </>
  );
}
