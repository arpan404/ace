import { useThreadMeta } from "@ace/client-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { usePhone } from "@/lib/breakpoints.ts";
import { useBrowsingThreads } from "@/lib/browsing.ts";
import { WithServices } from "../with-services.tsx";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { BrowserPip } from "./browser-pip.tsx";
import {
  addThread,
  browsersOnScreen,
  dismissedPip,
  floatingCandidates,
  floatingThreads,
  removeThread,
  seenBrowsers,
} from "./floating-state.ts";
import { pipPage } from "./pip-rules.ts";
import { useAutomaticPip } from "./pip-setting.ts";
import { useShowBrowserPanel } from "./reveal-tab.ts";

const same = <T,>(value: T) => value;

/**
 * Every thread's page that floats in picture-in-picture, over whatever screen shows: one
 * window per thread whose Browser the person looked at, while an agent browses there (or the
 * open thread's page plays sound) and its Browser isn't on screen. Each streams its own video.
 */
function FloatingBrowsers() {
  "use no memo";
  const current = useParams({ strict: false }).threadId;
  const seen = useLocal(seenBrowsers, same);
  const onScreen = useLocal(browsersOnScreen, same);
  const dismissed = useLocal(dismissedPip, same);
  const browsing = useBrowsingThreads();
  const [enabled] = useAutomaticPip();
  const phone = usePhone();
  const threads = floatingCandidates({
    current,
    seen,
    onScreen,
    dismissed,
    browsing,
    enabled,
    phone,
  });
  return threads.map((threadId, slot) => (
    <FloatingThread key={threadId} threadId={threadId} slot={slot} current={threadId === current} />
  ));
}

/** One thread's floating window, while its page is one to float (`pipPage`). */
function FloatingThread(props: { threadId: string; slot: number; current: boolean }) {
  "use no memo";
  const { preview: source } = usePanelServices();
  const { threadId } = props;
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  // Watched while it may float, so its tabs and video keep coming once the person leaves it.
  useEffect(() => source.watch(threadId), [source, threadId]);
  const view = source.view(threadId);
  const page = pipPage({ view, showingBrowser: false, dismissed: false, enabled: true });
  const floats = !!page;
  useEffect(() => {
    if (!floats) return;
    addThread(floatingThreads, threadId);
    return () => removeThread(floatingThreads, threadId);
  }, [floats, threadId]);
  const title = useThreadMeta(threadId)?.title;
  const showBrowser = useShowBrowserPanel(threadId);
  const navigate = useNavigate();
  if (!page) return null;
  const restore = () => {
    showBrowser(page.tabId);
    if (!props.current) void navigate({ to: "/t/$threadId", params: { threadId } });
  };
  return (
    <BrowserPip
      source={source}
      threadId={threadId}
      frame={source.frame(threadId)}
      page={page}
      threadTitle={title}
      slot={props.slot}
      onRestore={restore}
      onDismiss={() => addThread(dismissedPip, threadId)}
    />
  );
}

export default function FloatingBrowsersBoundary() {
  return (
    <WithServices quiet>
      <FloatingBrowsers />
    </WithServices>
  );
}
