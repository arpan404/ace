import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { WithServices } from "../with-services.tsx";
import { usePanelServices } from "../services.ts";
import { PageView } from "./page-view.tsx";

/*
 * A Spade bot's browser tab, live: the bot acts in ace's browser as a hidden thread of its own,
 * so this is the thread browser's page view on that thread, showing the bot's tab, with the bot's
 * cursor where it works. It shows the tab to the person (the video follows the shown tab) and
 * takes their pointer and keys whenever they may act: in cowork straight away (the daemon makes
 * the bot wait while the person's input is recent), in exclusive mode while they drive. Only in
 * exclusive mode does the page follow the pane; in cowork it never resizes the bot's page.
 */

export interface BotBrowserProps {
  /** The bot's hidden thread. */
  threadId: string;
  /** The bot's tab; the thread's shown tab when Spade hasn't said. */
  tabId: string | undefined;
  /** The person's input goes to the page now (cowork, or exclusive while they drive). */
  mayAct: boolean;
  /** Exclusive mode is the person's: the page follows the pane. */
  driving: boolean;
  /** The bot, for its cursor: its name and face. */
  agent: { name: string; mark: ReactNode };
  /** Said while the page hasn't opened yet. */
  waiting: string;
}

function BotBrowser(props: BotBrowserProps) {
  const { preview: source } = usePanelServices();
  const { threadId, tabId } = props;
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  useEffect(() => source.watch(threadId), [source, threadId]);
  const view = source.view(threadId);
  const listed = view?.tabs?.some((tab) => tab.tabId === tabId) === true;
  // The picture follows the tab shown in the thread: show the bot's.
  useEffect(() => {
    if (tabId && listed && view?.activeTabId !== tabId)
      void source.selectTab(threadId, tabId).catch(() => {});
  }, [source, threadId, tabId, listed, view?.activeTabId]);
  if (!view || view.closed)
    return (
      <p className="grid h-full place-items-center px-6 text-center text-ui text-muted-foreground">
        {props.waiting}
      </p>
    );
  const tab = view.tabs?.find((each) => each.tabId === (listed ? tabId : view.activeTabId));
  return (
    <PageView
      source={source}
      threadId={threadId}
      view={view}
      tab={tab}
      frame={source.frame(threadId)}
      interactive={props.mayAct}
      fit={props.driving}
      agent={props.agent}
    />
  );
}

export default function BotBrowserBoundary(props: BotBrowserProps) {
  return (
    <WithServices quiet>
      <BotBrowser {...props} />
    </WithServices>
  );
}
