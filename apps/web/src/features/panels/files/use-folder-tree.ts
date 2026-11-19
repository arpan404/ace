import { useClient, useConnectionState } from "@ace/client-react";
import type { FolderPage } from "@ace/protocol";
import {
  folderKey,
  folderPageArrived,
  folderPageFailed,
  folderRequestLimit,
  folderRequestPath,
  folderRequestRepeated,
  folderRequestSettled,
  folderRequestStarted,
  folderRows,
  folderStopped,
  foldersToRelist,
  noFolderRequests,
  orderedFolderRequests,
  relistLimit,
  retryPage,
  startingFolderPage,
  visibleOpenFolders,
  type FolderRequestState,
  type FolderRow,
  type FolderStates,
} from "@ace/ui-core";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { checkoutError } from "./checkout-source.ts";
import { refreshEvents, useCheckoutRefresh } from "./checkout-refresh.ts";
import { watchFolders } from "./folder-watch.ts";
import { fileManagement } from "./file-management-source.ts";

/** The page size a folder asks for; a re-list asks for what it already shows. */
const pageSize = 500;

type Mode = "first" | "more";

type Action =
  | { type: "list"; folder: string; first: boolean }
  | { type: "stopped"; folder: string }
  | { type: "page"; folder: string; cursor: string | undefined; page: FolderPage }
  | { type: "failed"; folder: string; code: string; message: string };

function reduce(folders: FolderStates, action: Action): FolderStates {
  switch (action.type) {
    case "list":
      return startingFolderPage(folders, action.folder, action.first);
    case "stopped":
      return folderStopped(folders, action.folder);
    case "page":
      return folderPageArrived(folders, action.folder, action.page, action.cursor);
    case "failed":
      return folderPageFailed(folders, action.folder, action);
  }
}

interface Queued {
  mode: Mode;
  retried: boolean;
}

interface Result {
  kind: "page" | "error";
  error?: unknown;
  page?: FolderPage;
  cursor: string | undefined;
  retried: boolean;
}

export interface FolderTree {
  /** The rows the virtual list draws, for the folders the person opened. */
  rows: FolderRow[];
  /** List another page of `folder`, whose row offered Show more. */
  showMore(folder: string): void;
  /** Retry the page that failed for `folder` (a next page, or the folder's first). */
  retry(folder: string): void;
  /** Where focus goes after a folder's cursor went stale and it restarted: its row. */
  focus: { folder: string; at: number } | undefined;
}

/**
 * The Files explorer's lazy tree: the root is listed once, a folder when it becomes visible, and
 * only a page at a time. Visible folders are watched (one `files.watch` set per thread) and
 * listed again when the daemon says one changed (`files.folders_changed`), so the tree follows
 * agents writing files. Hidden folders keep what they loaded but are neither listed nor watched.
 * At most six listings are on their way; the rest wait, and a re-list asked for during a listing
 * waits for it instead of starting again.
 */
export function useFolderTree(options: {
  threadId: string;
  /** The folders the tree shows open, as the tab keeps them. */
  expanded: ReadonlySet<string>;
  /** True while the tree shows search results: listing waits, and resumes where it left off. */
  paused: boolean;
}): FolderTree {
  const client = useClient();
  const online = useConnectionState() === "ready";
  const { threadId, expanded, paused } = options;
  const refresh = useCheckoutRefresh(threadId);
  const [folders, dispatch] = useReducer(reduce, undefined, () => ({}) as FolderStates);
  const [focus, setFocus] = useState<{ folder: string; at: number }>();
  const focusAt = useRef(0);

  const openKey = useMemo(
    () => [...new Set(["", ...expanded])].map(folderKey).toSorted().join("\0"),
    [expanded],
  );
  const open = useMemo(() => new Set(openKey.split("\0")), [openKey]);
  const visibleKey = useMemo(() => [...visibleOpenFolders(open)].toSorted().join("\0"), [open]);
  const visible = useMemo(() => new Set(visibleKey.split("\0")), [visibleKey]);
  const order = useMemo(() => visibleKey.split("\0"), [visibleKey]);

  const foldersRef = useRef<FolderStates>(folders);
  const live = useRef({ visible, online, paused, order });
  useEffect(() => {
    foldersRef.current = folders;
    live.current = { visible, online, paused, order };
  }, [folders, visible, online, paused, order]);

  const queue = useRef(new Map<string, Queued>());
  const requests = useRef<FolderRequestState>(noFolderRequests);
  const controllers = useRef(new Map<string, AbortController>());
  const active = useRef(0);
  const sequence = useRef(0);
  const deferred = useRef(new Set<string>());
  const alive = useRef(true);
  const requestRef = useRef<(folder: string, mode: Mode, retried?: boolean) => void>(() => {});
  const pumpRef = useRef<() => void>(() => {});
  const runRef = useRef<(folder: string, mode: Mode, retried: boolean) => void>(() => {});
  const settleRef = useRef<(folder: string, token: number, result: Result) => void>(() => {});

  /** Ask for a page of `folder`; a request already on its way gets a re-list when it ends. */
  const request = useCallback((folder: string, mode: Mode, retried = false) => {
    const key = folderKey(folder);
    if (!live.current.visible.has(key)) return;
    if (!live.current.online || live.current.paused) {
      deferred.current.add(key);
      return;
    }
    if (requests.current.requests[key]) {
      requests.current = folderRequestRepeated(requests.current, key);
      return;
    }
    const queued = queue.current.get(key);
    if (!queued) queue.current.set(key, { mode, retried });
    else if (mode === "first") queue.current.set(key, { mode, retried });
    pumpRef.current();
  }, []);

  const run = useCallback(
    (folder: string, mode: Mode, retried: boolean) => {
      if (!live.current.online || live.current.paused || !live.current.visible.has(folder)) return;
      const state = foldersRef.current[folder];
      const cursor =
        mode === "more" && typeof state?.nextCursor === "string" ? state.nextCursor : undefined;
      if (mode === "more" && cursor === undefined) return;
      // A re-list asks for what it already shows, so the rows it has stay put.
      const limit = mode === "more" ? pageSize : relistLimit(state);
      const controller = new AbortController();
      const token = ++sequence.current;
      requests.current = folderRequestStarted(requests.current, folder, token);
      controllers.current.set(folder, controller);
      active.current += 1;
      dispatch({ type: "list", folder, first: mode === "first" });
      void fileManagement(client, threadId)
        .listFolder(folderRequestPath(folder), cursor, limit, controller.signal)
        .then(
          (page) => settleRef.current(folder, token, { kind: "page", page, cursor, retried }),
          (error: unknown) =>
            settleRef.current(folder, token, { kind: "error", error, cursor, retried }),
        );
    },
    [client, threadId],
  );

  const settle = useCallback((folder: string, token: number, result: Result) => {
    active.current = Math.max(0, active.current - 1);
    const current = requests.current.requests[folder]?.token === token;
    const settled = folderRequestSettled(requests.current, folder, token);
    requests.current = settled.state;
    if (current) controllers.current.delete(folder);
    if (current && alive.current) {
      if (result.kind === "page" && result.page) {
        dispatch({ type: "page", folder, cursor: result.cursor, page: result.page });
        if (settled.relist) requestRef.current(folder, "first");
      } else {
        const failure = checkoutError(result.error);
        dispatch({ type: "failed", folder, code: failure.code, message: failure.message });
        if (failure.code === "INVALID_CURSOR" && !result.retried) {
          const at = ++focusAt.current;
          setFocus({ folder, at });
          requestRef.current(folder, "first", true);
        } else if (settled.relist) {
          requestRef.current(folder, "first");
        }
      }
    }
    pumpRef.current();
  }, []);

  const pump = useCallback(() => {
    while (active.current < folderRequestLimit) {
      for (const folder of Array.from(queue.current.keys()))
        if (!live.current.visible.has(folder)) queue.current.delete(folder);
      const next = orderedFolderRequests(
        [...queue.current.entries()].map(([folder, queued]) => ({ folder, mode: queued.mode })),
        live.current.visible,
      )[0];
      if (!next) return;
      const queued = queue.current.get(next.folder);
      queue.current.delete(next.folder);
      if (queued) runRef.current(next.folder, queued.mode, queued.retried);
    }
  }, []);

  const stop = useCallback((folder: string) => {
    queue.current.delete(folder);
    const entry = requests.current.requests[folder];
    if (!entry) return;
    controllers.current.get(folder)?.abort();
    controllers.current.delete(folder);
    requests.current = folderRequestSettled(requests.current, folder, entry.token).state;
    dispatch({ type: "stopped", folder });
  }, []);

  const stopAll = useCallback(() => {
    for (const folder of Object.keys(requests.current.requests)) stop(folder);
    queue.current.clear();
  }, [stop]);

  useEffect(() => {
    requestRef.current = request;
    pumpRef.current = pump;
    runRef.current = run;
    settleRef.current = settle;
  });

  // List a folder when it becomes visible (the root on mount, and every visible folder after a
  // reconnect). While the tree is paused, nothing is listed; on resume, only folders that never
  // loaded and folders the daemon named meanwhile.
  const previous = useRef({ visible: new Set<string>(), online: false, paused: false });

  // React may disconnect and reconnect effects while keeping refs (StrictMode, a hidden
  // Activity): reconnecting arms the tree again and lists every visible folder afresh, since
  // disconnecting stopped whatever was on its way.
  useEffect(() => {
    alive.current = true;
    previous.current = { visible: new Set<string>(), online: false, paused: false };
    return () => {
      alive.current = false;
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
      requests.current = noFolderRequests;
      queue.current.clear();
    };
  }, []);

  useEffect(() => {
    const before = previous.current;
    previous.current = { visible: new Set(visible), online, paused };
    if (!online || paused) {
      stopAll();
      return;
    }
    if (!before.online) {
      for (const folder of order) request(folder, "first");
      return;
    }
    if (before.paused) {
      for (const folder of order)
        if (!foldersRef.current[folder] || deferred.current.has(folder)) request(folder, "first");
      deferred.current.clear();
      return;
    }
    for (const folder of order) if (!before.visible.has(folder)) request(folder, "first");
    for (const folder of before.visible) if (!visible.has(folder)) stop(folder);
  }, [order, visible, online, paused, request, stop, stopAll]);

  // This window's own mutations name the folders whose rows changed; list those that are open.
  // Agent writes arrive as files.folders_changed instead, handled below.
  const lastRefresh = useRef(refresh);
  useEffect(() => {
    const events = refreshEvents(threadId, lastRefresh.current);
    lastRefresh.current = refresh;
    for (const folder of new Set(events.flatMap((event) => event.folders))) {
      const key = folderKey(folder);
      if (!live.current.visible.has(key)) continue;
      if (!live.current.online || live.current.paused) deferred.current.add(key);
      else request(key, "first");
    }
  }, [refresh, request, threadId]);

  // The daemon names only folders in this thread's watch set, once per change; list each once.
  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type !== "files.folders_changed" || message.threadId !== threadId) return;
        const changed = message.rescan
          ? [...live.current.visible]
          : foldersToRelist(live.current.visible, message.folders, false);
        for (const folder of changed) {
          if (!live.current.online || live.current.paused) deferred.current.add(folder);
          else request(folder, "first");
        }
      }),
    [client, request, threadId],
  );

  // One watch set per thread, shared by every tree showing it; a reconnect sends it again.
  const watch = useMemo(() => watchFolders(client, threadId), [client, threadId]);
  useEffect(() => () => watch.leave(), [watch]);
  useEffect(() => {
    watch.set(visible);
  }, [watch, visible]);
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) watch.resume();
    wasOnline.current = online;
  }, [online, watch]);

  const rows = useMemo(() => folderRows(folders, open), [folders, open]);
  const showMore = useCallback((folder: string) => request(folder, "more"), [request]);
  const retry = useCallback(
    (folder: string) => request(folder, retryPage(foldersRef.current[folder]).mode),
    [request],
  );
  return { rows, showMore, retry, focus };
}
