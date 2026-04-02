import { GlobeIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { type BrowserTabState, resolveBrowserTabTitle } from "~/lib/browser/session";
import {
  type BrowserTabHandle,
  type BrowserTabSnapshot,
  type BrowserWebview,
  IN_APP_BROWSER_PARTITION,
} from "~/lib/browser/types";

function resolveBrowserFaviconSources(url: string): string[] {
  try {
    const parsed = new URL(url);
    const domainUrl = encodeURIComponent(parsed.origin);
    return [
      `https://www.google.com/s2/favicons?domain_url=${domainUrl}&sz=64`,
      new URL("/favicon.ico", parsed.origin).toString(),
    ];
  } catch {
    return [];
  }
}

export function BrowserFavicon(props: {
  url: string;
  title: string;
  className?: string;
  fallbackClassName?: string;
}) {
  const { className, fallbackClassName, title, url } = props;
  const sources = useMemo(() => resolveBrowserFaviconSources(url), [url]);
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [sources]);

  const source = sources[sourceIndex];
  if (!source) {
    return (
      <GlobeIcon className={cn("shrink-0", fallbackClassName, className)} aria-hidden="true" />
    );
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 rounded-sm object-cover", className)}
      src={source}
      title={title}
      onError={() => {
        setSourceIndex((current) => {
          const nextIndex = current + 1;
          return nextIndex < sources.length ? nextIndex : current;
        });
      }}
    />
  );
}

export function BrowserTabWebview(props: {
  active: boolean;
  onContextMenuFallbackRequest: (
    tabId: string,
    position: { x: number; y: number },
    requestedAt: number,
  ) => void;
  tab: BrowserTabState;
  onHandleChange: (tabId: string, handle: BrowserTabHandle | null) => void;
  onSnapshotChange: (tabId: string, snapshot: BrowserTabSnapshot) => void;
}) {
  const { active, onContextMenuFallbackRequest, tab, onHandleChange, onSnapshotChange } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<BrowserWebview | null>(null);
  const readyRef = useRef(false);
  const pendingUrlRef = useRef<string | null>(null);
  const requestedUrlRef = useRef(tab.url);

  const emitSnapshot = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current) {
      return;
    }
    const currentUrl = webview.getURL();
    const resolvedUrl = currentUrl.trim().length > 0 ? currentUrl : requestedUrlRef.current;
    onSnapshotChange(tab.id, {
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
      devToolsOpen: webview.isDevToolsOpened(),
      loading: webview.isLoading(),
      title: resolveBrowserTabTitle(resolvedUrl, webview.getTitle()),
      url: resolvedUrl,
    });
  }, [onSnapshotChange, tab.id]);

  const navigate = useCallback(
    (url: string) => {
      requestedUrlRef.current = url;
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) {
        pendingUrlRef.current = url;
        return;
      }
      const currentUrl = webview.getURL();
      if (currentUrl === url) {
        emitSnapshot();
        return;
      }
      webview.loadURL(url);
    },
    [emitSnapshot],
  );

  useEffect(() => {
    const handle: BrowserTabHandle = {
      closeDevTools: () => {
        if (!readyRef.current || !webviewRef.current?.isDevToolsOpened()) return;
        webviewRef.current.closeDevTools();
      },
      goBack: () => {
        if (!readyRef.current || !webviewRef.current?.canGoBack()) return;
        webviewRef.current.goBack();
      },
      goForward: () => {
        if (!readyRef.current || !webviewRef.current?.canGoForward()) return;
        webviewRef.current.goForward();
      },
      isDevToolsOpen: () => {
        if (!readyRef.current || !webviewRef.current) return false;
        return webviewRef.current.isDevToolsOpened();
      },
      navigate,
      openDevTools: () => {
        if (!readyRef.current || !webviewRef.current || webviewRef.current.isDevToolsOpened()) {
          return;
        }
        webviewRef.current.openDevTools({ mode: "detach" });
      },
      reload: () => {
        if (!readyRef.current || !webviewRef.current) return;
        webviewRef.current.reload();
      },
      stop: () => {
        if (!readyRef.current || !webviewRef.current) return;
        webviewRef.current.stop();
      },
    };
    onHandleChange(tab.id, handle);
    return () => {
      onHandleChange(tab.id, null);
    };
  }, [navigate, onHandleChange, tab.id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || webviewRef.current) return;

    const webview = document.createElement("webview") as BrowserWebview;
    webview.className = "size-full bg-background";
    webview.setAttribute("partition", IN_APP_BROWSER_PARTITION);
    webview.setAttribute("src", requestedUrlRef.current);

    const handleDomReady = () => {
      readyRef.current = true;
      const pendingUrl = pendingUrlRef.current;
      pendingUrlRef.current = null;
      if (pendingUrl && pendingUrl !== webview.getURL()) {
        webview.loadURL(pendingUrl);
        return;
      }
      emitSnapshot();
    };
    const handleLoadStart = () => {
      onSnapshotChange(tab.id, {
        canGoBack: readyRef.current ? webview.canGoBack() : false,
        canGoForward: readyRef.current ? webview.canGoForward() : false,
        devToolsOpen: readyRef.current ? webview.isDevToolsOpened() : false,
        loading: true,
        title: resolveBrowserTabTitle(requestedUrlRef.current),
        url: requestedUrlRef.current,
      });
    };
    const handleNavigation = () => {
      emitSnapshot();
    };
    const handleFailLoad = (event: Event) => {
      const detail = event as Event & { errorCode?: number };
      if (detail.errorCode === -3) {
        return;
      }
      emitSnapshot();
    };
    const handleContextMenu = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      onContextMenuFallbackRequest(
        tab.id,
        { x: mouseEvent.clientX, y: mouseEvent.clientY },
        performance.now(),
      );
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleLoadStart);
    webview.addEventListener("did-stop-loading", handleNavigation);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("devtools-closed", handleNavigation);
    webview.addEventListener("devtools-opened", handleNavigation);
    webview.addEventListener("page-title-updated", handleNavigation);
    webview.addEventListener("did-fail-load", handleFailLoad);
    webview.addEventListener("contextmenu", handleContextMenu);

    host.replaceChildren(webview);
    webviewRef.current = webview;

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleLoadStart);
      webview.removeEventListener("did-stop-loading", handleNavigation);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("devtools-closed", handleNavigation);
      webview.removeEventListener("devtools-opened", handleNavigation);
      webview.removeEventListener("page-title-updated", handleNavigation);
      webview.removeEventListener("did-fail-load", handleFailLoad);
      webview.removeEventListener("contextmenu", handleContextMenu);
      host.replaceChildren();
      webviewRef.current = null;
      readyRef.current = false;
    };
  }, [emitSnapshot, onContextMenuFallbackRequest, onSnapshotChange, tab.id]);

  useEffect(() => {
    navigate(tab.url);
  }, [navigate, tab.url]);

  return (
    <div
      aria-hidden={!active}
      className={cn(
        "absolute inset-0 min-h-0 [&_webview]:size-full",
        active
          ? "pointer-events-auto visible opacity-100"
          : "pointer-events-none invisible opacity-0",
      )}
    >
      <div ref={hostRef} className="size-full min-h-0" />
    </div>
  );
}
