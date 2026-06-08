import { ThreadId } from "@ace/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

import { ThreadBoard } from "../components/chat/ThreadBoard";
import { useComposerDraftStore } from "../composerDraftStore";
import { type DiffRouteSearch, parseDiffRouteSearch } from "../diffRouteSearch";
import { prefetchThreadTimelineWindows } from "../lib/chat/timelineWindowStore";
import { getThreadById, getThreadByIdFromState, useStore } from "../store";
import { SidebarInset } from "~/components/ui/sidebar";
import { getWsRpcClient } from "../wsRpcClient";
import { normalizeWsUrl } from "../lib/remoteHosts";
import { THREAD_ROUTE_CONNECTION_SEARCH_PARAM } from "../lib/connectionRouting";
import { useHostConnectionStore } from "../hostConnectionStore";
import { resolveThreadLineageSourceThreadId } from "../lib/chat/handoff";

export interface ChatThreadRouteSearch extends DiffRouteSearch {
  readonly connection?: string;
}

function parseChatThreadRouteSearch(search: Record<string, unknown>): ChatThreadRouteSearch {
  const diffSearch = parseDiffRouteSearch(search);
  const connectionRaw =
    typeof search[THREAD_ROUTE_CONNECTION_SEARCH_PARAM] === "string"
      ? search[THREAD_ROUTE_CONNECTION_SEARCH_PARAM].trim()
      : "";
  if (connectionRaw.length === 0) {
    return diffSearch;
  }
  try {
    return {
      ...diffSearch,
      connection: normalizeWsUrl(connectionRaw),
    };
  } catch {
    return diffSearch;
  }
}

function ChatThreadRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const routeConnectionUrl = search.connection;
  const serverThread = useStore((store) => getThreadByIdFromState(store, threadId));
  const threadExists = serverThread !== undefined;
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const threadHydrationInFlightRef = useRef<ThreadId | null>(null);
  const threadHydrationRequestIdRef = useRef(0);
  useEffect(() => {
    const preloadTimer = window.setTimeout(() => {
      void import("../components/DiffPanel");
    }, 350);
    return () => {
      window.clearTimeout(preloadTimer);
    };
  }, []);

  useEffect(() => {
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
    if (!bootstrapComplete) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [bootstrapComplete, navigate, routeThreadExists, threadId]);

  const runThreadHydration = useCallback(() => {
    if (
      !bootstrapComplete ||
      !serverThread ||
      serverThread.historyLoaded !== false ||
      threadHydrationInFlightRef.current === threadId
    ) {
      return;
    }

    let canceled = false;
    const requestId = threadHydrationRequestIdRef.current + 1;
    threadHydrationRequestIdRef.current = requestId;
    threadHydrationInFlightRef.current = threadId;
    void (async () => {
      try {
        await prefetchThreadTimelineWindows({
          threadId,
          priority: "immediate",
        });
        if (canceled) {
          return;
        }
      } catch {
        // Timeline windows are opportunistic here; the visible timeline also fetches ranges on scroll.
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
  }, [bootstrapComplete, serverThread, threadId]);

  useEffect(() => {
    runThreadHydration();
  }, [runThreadHydration]);

  useEffect(
    () =>
      getWsRpcClient().subscribeConnectionState((state) => {
        if (state.kind !== "reconnected") {
          return;
        }
        runThreadHydration();
      }),
    [runThreadHydration],
  );

  const lineageSourceThreadId = serverThread
    ? resolveThreadLineageSourceThreadId(serverThread)
    : null;
  const lineageSourceThread = useStore((store) =>
    lineageSourceThreadId ? getThreadById(store.threads, lineageSourceThreadId) : undefined,
  );
  useEffect(() => {
    if (!bootstrapComplete || !lineageSourceThreadId) {
      return;
    }
    const sourceThread = lineageSourceThread;
    if (sourceThread && sourceThread.historyLoaded !== false) {
      return;
    }
    let canceled = false;
    void (async () => {
      try {
        await prefetchThreadTimelineWindows({
          threadId: lineageSourceThreadId,
          priority: "background",
        });
        if (canceled) {
          return;
        }
      } catch (error) {
        console.error("Failed to prefetch conversation source timeline", error);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [bootstrapComplete, lineageSourceThread, lineageSourceThreadId]);

  if (!bootstrapComplete || !routeThreadExists) {
    return null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none text-foreground">
      <ThreadBoard threadId={threadId} connectionUrl={routeConnectionUrl ?? null} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseChatThreadRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<ChatThreadRouteSearch>(["diff", "connection"])],
  },
  component: ChatThreadRouteView,
});
