import { ThreadId } from "@ace/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { startTransition, useCallback, useEffect, useRef } from "react";

import { ThreadBoard } from "../components/chat/ThreadBoard";
import { useComposerDraftStore } from "../composerDraftStore";
import { type DiffRouteSearch, parseDiffRouteSearch } from "../diffRouteSearch";
import {
  hydrateThreadFromCache,
  readCachedHydratedThread,
  resolveThreadHydrationRetryDelayMs,
} from "../lib/threadHydrationCache";
import { getThreadById, getThreadByIdFromState, useStore } from "../store";
import { SidebarInset } from "~/components/ui/sidebar";
import { getWsRpcClient } from "../wsRpcClient";
import { normalizeWsUrl } from "../lib/remoteHosts";
import { THREAD_ROUTE_CONNECTION_SEARCH_PARAM } from "../lib/connectionRouting";
import { useHostConnectionStore } from "../hostConnectionStore";
import { resolveThreadLineageSourceThreadId } from "../lib/chat/handoff";

function clearThreadHydrationRetry(
  retryTimeoutRef: { current: ReturnType<typeof setTimeout> | null },
  retryAtRef: { current: number | null },
): void {
  if (retryTimeoutRef.current !== null) {
    clearTimeout(retryTimeoutRef.current);
    retryTimeoutRef.current = null;
  }
  retryAtRef.current = null;
}

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
  const hydrateThreadFromReadModel = useStore((store) => store.hydrateThreadFromReadModel);
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
  const threadHydrationFailureCountRef = useRef(0);
  const threadHydrationRetryAtRef = useRef<number | null>(null);
  const threadHydrationRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cachedHydratedThread =
    serverThread?.historyLoaded === false && serverThread.updatedAt
      ? readCachedHydratedThread(threadId, serverThread.updatedAt)
      : null;
  useEffect(() => {
    const preloadTimer = window.setTimeout(() => {
      void import("../components/DiffPanel");
    }, 350);
    return () => {
      window.clearTimeout(preloadTimer);
    };
  }, []);

  useEffect(() => {
    threadHydrationFailureCountRef.current = 0;
    clearThreadHydrationRetry(threadHydrationRetryTimeoutRef, threadHydrationRetryAtRef);
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
      threadHydrationRetryAtRef.current !== null ||
      threadHydrationInFlightRef.current === threadId
    ) {
      return;
    }

    if (cachedHydratedThread) {
      threadHydrationFailureCountRef.current = 0;
      clearThreadHydrationRetry(threadHydrationRetryTimeoutRef, threadHydrationRetryAtRef);
      hydrateThreadFromReadModel(cachedHydratedThread);
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
        clearThreadHydrationRetry(threadHydrationRetryTimeoutRef, threadHydrationRetryAtRef);
        hydrateThreadFromReadModel(readModelThread);
      } catch {
        if (!canceled) {
          const nextFailureCount = threadHydrationFailureCountRef.current + 1;
          threadHydrationFailureCountRef.current = nextFailureCount;
          const delayMs = resolveThreadHydrationRetryDelayMs(nextFailureCount);
          clearThreadHydrationRetry(threadHydrationRetryTimeoutRef, threadHydrationRetryAtRef);
          threadHydrationRetryAtRef.current = Date.now() + delayMs;
          threadHydrationRetryTimeoutRef.current = setTimeout(() => {
            clearThreadHydrationRetry(threadHydrationRetryTimeoutRef, threadHydrationRetryAtRef);
            runThreadHydration();
          }, delayMs);
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
  }, [bootstrapComplete, cachedHydratedThread, hydrateThreadFromReadModel, serverThread, threadId]);

  useEffect(() => {
    runThreadHydration();
  }, [runThreadHydration]);

  useEffect(
    () =>
      getWsRpcClient().subscribeConnectionState((state) => {
        if (state.kind !== "reconnected") {
          return;
        }
        clearThreadHydrationRetry(threadHydrationRetryTimeoutRef, threadHydrationRetryAtRef);
        runThreadHydration();
      }),
    [runThreadHydration],
  );

  useEffect(
    () => () => {
      clearThreadHydrationRetry(threadHydrationRetryTimeoutRef, threadHydrationRetryAtRef);
    },
    [],
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
    if (sourceThread?.updatedAt) {
      const cached = readCachedHydratedThread(lineageSourceThreadId, sourceThread.updatedAt);
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
        const readModelThread = await hydrateThreadFromCache(lineageSourceThreadId, {
          expectedUpdatedAt: sourceThread?.updatedAt ?? null,
        });
        if (canceled) {
          return;
        }
        startTransition(() => {
          hydrateThreadFromReadModel(readModelThread);
        });
      } catch (error) {
        console.error("Failed to hydrate conversation source thread", error);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [bootstrapComplete, lineageSourceThread, lineageSourceThreadId, hydrateThreadFromReadModel]);

  if (!bootstrapComplete || !routeThreadExists) {
    return null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
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
