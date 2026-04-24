import { ThreadId } from "@ace/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import {
  Suspense,
  lazy,
  startTransition,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ThreadBoard } from "../components/chat/ThreadBoard";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { hydrateThreadFromCache, readCachedHydratedThread } from "../lib/threadHydrationCache";
import { getThreadById, useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { getWsRpcClient } from "../wsRpcClient";
import { normalizeWsUrl } from "../lib/remoteHosts";
import { THREAD_ROUTE_CONNECTION_SEARCH_PARAM } from "../lib/connectionRouting";
import {
  THREAD_BOARD_THREADS_SEARCH_PARAM,
  THREAD_BOARD_ACTIVE_SEARCH_PARAM,
  THREAD_BOARD_SPLIT_SEARCH_PARAM,
  decodeThreadBoardRoutePane,
  parseThreadBoardRoutePanes,
} from "../lib/chatThreadBoardRouteSearch";
import { useHostConnectionStore } from "../hostConnectionStore";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
const INITIAL_THREAD_HYDRATION_RETRY_DELAY_MS = 500;
const MAX_THREAD_HYDRATION_RETRY_DELAY_MS = 10_000;

export interface ChatThreadRouteSearch extends DiffRouteSearch {
  readonly active?: string;
  readonly connection?: string;
  readonly split?: string;
  readonly threads?: string;
}

function parseChatThreadRouteSearch(search: Record<string, unknown>): ChatThreadRouteSearch {
  const diffSearch = parseDiffRouteSearch(search);
  const active =
    typeof search[THREAD_BOARD_ACTIVE_SEARCH_PARAM] === "string"
      ? search[THREAD_BOARD_ACTIVE_SEARCH_PARAM].trim()
      : "";
  const threads =
    typeof search[THREAD_BOARD_THREADS_SEARCH_PARAM] === "string"
      ? search[THREAD_BOARD_THREADS_SEARCH_PARAM].trim()
      : "";
  const split =
    typeof search[THREAD_BOARD_SPLIT_SEARCH_PARAM] === "string"
      ? search[THREAD_BOARD_SPLIT_SEARCH_PARAM].trim()
      : "";
  const connectionRaw =
    typeof search[THREAD_ROUTE_CONNECTION_SEARCH_PARAM] === "string"
      ? search[THREAD_ROUTE_CONNECTION_SEARCH_PARAM].trim()
      : "";
  const boardSearch = {
    ...diffSearch,
    ...(active.length > 0 ? { active } : {}),
    ...(split.length > 0 ? { split } : {}),
    ...(threads.length > 0 ? { threads } : {}),
  };
  if (connectionRaw.length === 0) {
    return boardSearch;
  }
  try {
    return {
      ...boardSearch,
      connection: normalizeWsUrl(connectionRaw),
    };
  } catch {
    return boardSearch;
  }
}

function resolveThreadHydrationRetryDelayMs(failureCount: number): number {
  return Math.min(
    MAX_THREAD_HYDRATION_RETRY_DELAY_MS,
    INITIAL_THREAD_HYDRATION_RETRY_DELAY_MS * 2 ** Math.max(0, failureCount - 1),
  );
}

const DiffPanelSheet = (props: {
  children: ReactNode;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  return (
    <Sheet
      open={props.diffOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseDiff();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const DiffPanelInlineSidebar = (props: {
  diffOpen: boolean;
  shouldMountPanel: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
}) => {
  const { diffOpen, shouldMountPanel, onCloseDiff, onOpenDiff } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      onCloseDiff();
    },
    [onCloseDiff, onOpenDiff],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={diffOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {shouldMountPanel ? <LazyDiffPanel mode="sidebar" /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

function ChatThreadRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const hydrateThreadFromReadModel = useStore((store) => store.hydrateThreadFromReadModel);
  const store = useStore();
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const routeConnectionUrl = search.connection;
  const routeBoardPanes = useMemo(
    () => parseThreadBoardRoutePanes(search.threads),
    [search.threads],
  );
  const routePathBoardPane = useMemo(
    () => ({ connectionUrl: routeConnectionUrl ?? null, threadId }),
    [routeConnectionUrl, threadId],
  );
  const routeActiveBoardPane = useMemo(
    () => (search.active ? decodeThreadBoardRoutePane(search.active) : null),
    [search.active],
  );
  const serverThread = useStore((store) => getThreadById(store.threads, threadId));
  const threadExists = serverThread !== undefined;
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const splitModeOpen = routeBoardPanes.length > 1;
  const diffOpen = !splitModeOpen && search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const threadHydrationInFlightRef = useRef<ThreadId | null>(null);
  const threadHydrationRequestIdRef = useRef(0);
  const threadHydrationFailureCountRef = useRef(0);
  const [threadHydrationRetryAt, setThreadHydrationRetryAt] = useState<number | null>(null);
  const [hasOpenedDiffPanel, setHasOpenedDiffPanel] = useState(diffOpen);
  const cachedHydratedThread =
    serverThread?.historyLoaded === false && serverThread.updatedAt
      ? readCachedHydratedThread(threadId, serverThread.updatedAt)
      : null;
  const closeDiff = useCallback(() => {
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: { diff: undefined },
      });
    });
  }, [navigate, threadId]);
  const openDiff = useCallback(() => {
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return { ...rest, diff: "1" };
        },
      });
    });
  }, [navigate, threadId]);

  useEffect(() => {
    const preloadTimer = window.setTimeout(() => {
      void import("../components/DiffPanel");
    }, 350);
    return () => {
      window.clearTimeout(preloadTimer);
    };
  }, []);

  useEffect(() => {
    if (!diffOpen) {
      return;
    }
    setHasOpenedDiffPanel(true);
  }, [diffOpen]);

  useEffect(() => {
    threadHydrationFailureCountRef.current = 0;
    setThreadHydrationRetryAt(null);
    threadHydrationInFlightRef.current = null;
    threadHydrationRequestIdRef.current += 1;
  }, [threadId]);

  useEffect(() => {
    if (!routeConnectionUrl) {
      return;
    }
    useHostConnectionStore.getState().upsertThreadOwnership(routeConnectionUrl, threadId);
  }, [routeConnectionUrl, threadId]);

  useEffect(() => {
    if (threadHydrationRetryAt === null) {
      return;
    }
    const remainingDelay = Math.max(0, threadHydrationRetryAt - Date.now());
    const timer = window.setTimeout(() => {
      setThreadHydrationRetryAt((current) => (current === threadHydrationRetryAt ? null : current));
    }, remainingDelay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [threadHydrationRetryAt]);

  useEffect(
    () =>
      getWsRpcClient().subscribeConnectionState((state) => {
        if (state.kind !== "reconnected") {
          return;
        }
        setThreadHydrationRetryAt(null);
      }),
    [],
  );

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [bootstrapComplete, navigate, routeThreadExists, threadId]);

  useEffect(() => {
    if (
      !bootstrapComplete ||
      !serverThread ||
      serverThread.historyLoaded !== false ||
      threadHydrationRetryAt !== null ||
      threadHydrationInFlightRef.current === threadId
    ) {
      return;
    }

    if (cachedHydratedThread) {
      threadHydrationFailureCountRef.current = 0;
      setThreadHydrationRetryAt(null);
      startTransition(() => {
        hydrateThreadFromReadModel(cachedHydratedThread);
      });
      return;
    }

    let canceled = false;
    const requestId = threadHydrationRequestIdRef.current + 1;
    threadHydrationRequestIdRef.current = requestId;
    threadHydrationInFlightRef.current = threadId;
    void (async () => {
      try {
        const readModelThread = await hydrateThreadFromCache(threadId, {
          expectedUpdatedAt: serverThread.updatedAt ?? null,
        });
        if (canceled) {
          return;
        }
        threadHydrationFailureCountRef.current = 0;
        setThreadHydrationRetryAt(null);
        startTransition(() => {
          hydrateThreadFromReadModel(readModelThread);
        });
      } catch {
        if (!canceled) {
          const nextFailureCount = threadHydrationFailureCountRef.current + 1;
          threadHydrationFailureCountRef.current = nextFailureCount;
          const delayMs = resolveThreadHydrationRetryDelayMs(nextFailureCount);
          setThreadHydrationRetryAt(Date.now() + delayMs);
        }
      } finally {
        if (
          requestId === threadHydrationRequestIdRef.current &&
          threadHydrationInFlightRef.current === threadId
        ) {
          threadHydrationInFlightRef.current = null;
        }
      }
    })();

    return () => {
      canceled = true;
      if (
        requestId === threadHydrationRequestIdRef.current &&
        threadHydrationInFlightRef.current === threadId
      ) {
        threadHydrationInFlightRef.current = null;
      }
    };
  }, [
    bootstrapComplete,
    cachedHydratedThread,
    hydrateThreadFromReadModel,
    serverThread,
    threadHydrationRetryAt,
    threadId,
  ]);

  const handoffSourceThreadId = serverThread?.handoff?.sourceThreadId;
  useEffect(() => {
    if (!bootstrapComplete || !handoffSourceThreadId) {
      return;
    }
    const sourceThread = getThreadById(store.threads, handoffSourceThreadId);
    if (sourceThread && sourceThread.historyLoaded !== false) {
      return;
    }
    if (sourceThread?.updatedAt) {
      const cached = readCachedHydratedThread(handoffSourceThreadId, sourceThread.updatedAt);
      if (cached) {
        startTransition(() => {
          hydrateThreadFromReadModel(cached);
        });
        return;
      }
    }
    let canceled = false;
    void (async () => {
      try {
        const readModelThread = await hydrateThreadFromCache(handoffSourceThreadId, {
          expectedUpdatedAt: sourceThread?.updatedAt ?? null,
        });
        if (canceled) {
          return;
        }
        startTransition(() => {
          hydrateThreadFromReadModel(readModelThread);
        });
      } catch (error) {
        console.error("Failed to hydrate handoff source thread", error);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [bootstrapComplete, handoffSourceThreadId, store.threads, hydrateThreadFromReadModel]);

  if (!bootstrapComplete || !routeThreadExists) {
    return null;
  }

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ThreadBoard
            threadId={threadId}
            connectionUrl={routeConnectionUrl ?? null}
            routeActiveThread={routeActiveBoardPane ?? routePathBoardPane}
            routeSplitId={search.split ?? null}
            routeThreads={routeBoardPanes}
          />
        </SidebarInset>
        <DiffPanelInlineSidebar
          diffOpen={diffOpen}
          shouldMountPanel={hasOpenedDiffPanel}
          onCloseDiff={closeDiff}
          onOpenDiff={openDiff}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ThreadBoard
          threadId={threadId}
          connectionUrl={routeConnectionUrl ?? null}
          routeActiveThread={routeActiveBoardPane ?? routePathBoardPane}
          routeSplitId={search.split ?? null}
          routeThreads={routeBoardPanes}
        />
      </SidebarInset>
      <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeDiff}>
        {hasOpenedDiffPanel ? <LazyDiffPanel mode="sheet" /> : null}
      </DiffPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseChatThreadRouteSearch(search),
  search: {
    middlewares: [
      retainSearchParams<ChatThreadRouteSearch>([
        "diff",
        "connection",
        "threads",
        "active",
        "split",
      ]),
    ],
  },
  component: ChatThreadRouteView,
});
