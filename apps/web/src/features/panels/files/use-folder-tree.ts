import { useClient, useConnectionState } from "@ace/client-react";
import {
  folderKey,
  folderPageArrived,
  folderPageFailed,
  folderRequestPath,
  folderRows,
  foldersToRelist,
  startingFolderPage,
  watchedFolders,
  type FolderRow,
  type FolderStates,
} from "@ace/ui-core";
import { ThreadId, type FolderPage } from "@ace/protocol";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { checkoutError } from "./checkout-source.ts";
import { refreshEvents, useCheckoutRefresh } from "./checkout-refresh.ts";
import { fileManagement } from "./file-management-source.ts";

/** How long a change in the open set waits before `files.watch` names it. */
const watchDelay = 150;

type Action =
  | { type: "list"; folder: string; first: boolean }
  | { type: "page"; folder: string; cursor: string | undefined; page: FolderPage }
  | { type: "failed"; folder: string; code: string; message: string };

function reduce(folders: FolderStates, action: Action): FolderStates {
  switch (action.type) {
    case "list":
      return startingFolderPage(folders, action.folder, action.first);
    case "page":
      return folderPageArrived(folders, action.folder, action.page, action.cursor);
    case "failed":
      return folderPageFailed(folders, action.folder, action);
  }
}

export interface FolderTree {
  /** The rows the virtual list draws, for the folders the person opened. */
  rows: FolderRow[];
  /** List another page of `folder`, whose row offered Show more. */
  showMore(folder: string): void;
  /** List `folder` again from its first page, after a failed one. */
  retry(folder: string): void;
}

/**
 * The Files explorer's lazy tree: the root is listed once, a folder when it is opened, and only
 * a page at a time. Open folders are watched (`files.watch`) and listed again when the daemon
 * says one changed (`files.folders_changed`), so the tree follows agents writing files. Closed
 * folders are neither listed nor watched, and what they loaded stays for opening them again.
 */
export function useFolderTree(options: {
  threadId: string;
  /** The folders the tree shows open, as the tab keeps them. The root is always one of them. */
  expanded: ReadonlySet<string>;
  /** False while the tree shows search results: nothing is listed then. */
  active: boolean;
}): FolderTree {
  const client = useClient();
  const online = useConnectionState() === "ready";
  const { threadId, active } = options;
  const refresh = useCheckoutRefresh(threadId);
  const [folders, dispatch] = useReducer(reduce, undefined, () => ({}) as FolderStates);

  const openKey = useMemo(
    () => [...options.expanded].map(folderKey).toSorted().join("\0"),
    [options.expanded],
  );
  const open = useMemo(() => {
    const set = new Set<string>();
    if (!active) return set;
    set.add("");
    for (const folder of openKey.split("\0")) if (folder) set.add(folder);
    return set;
  }, [openKey, active]);

  const foldersRef = useRef<FolderStates>(folders);
  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  const running = useRef(new Map<string, { token: number; controller: AbortController }>());
  const sequence = useRef(0);
  const stop = useCallback((folder: string) => {
    const request = running.current.get(folder);
    if (!request) return;
    request.controller.abort();
    running.current.delete(folder);
  }, []);

  const start = useCallback(
    function list(folder: string, mode: "first" | "more", retried = false): void {
      if (!online) return;
      const nextCursor = foldersRef.current[folder]?.nextCursor;
      const cursor = mode === "more" && typeof nextCursor === "string" ? nextCursor : undefined;
      if (mode === "more" && cursor === undefined) return;
      stop(folder);
      const controller = new AbortController();
      const token = ++sequence.current;
      running.current.set(folder, { token, controller });
      dispatch({ type: "list", folder, first: mode === "first" });
      void fileManagement(client, threadId)
        .listFolder(folderRequestPath(folder), cursor, controller.signal)
        .then(
          (page) => {
            if (running.current.get(folder)?.token !== token) return;
            running.current.delete(folder);
            dispatch({ type: "page", folder, cursor, page });
          },
          (error: unknown) => {
            if (controller.signal.aborted || running.current.get(folder)?.token !== token) return;
            running.current.delete(folder);
            const failure = checkoutError(error);
            dispatch({
              type: "failed",
              folder,
              code: failure.code,
              message: failure.message,
            });
            // The cursor outlived its folder: list it again from the start, once.
            if (failure.code === "INVALID_CURSOR" && !retried) list(folder, "first", true);
          },
        );
    },
    [client, online, stop, threadId],
  );

  // List a folder when it opens (and the root on mount, and everything open after a reconnect):
  // never a folder that is closed.
  const seen = useRef({ open: new Set<string>(), online: false });
  useEffect(() => {
    const before = seen.current;
    seen.current = { open: new Set(open), online };
    if (!online) {
      for (const folder of before.open) stop(folder);
      return;
    }
    const fresh = !before.online;
    for (const folder of open) if (fresh || !before.open.has(folder)) start(folder, "first");
    for (const folder of before.open) if (!open.has(folder)) stop(folder);
  }, [open, online, start, stop]);

  // This window's own mutations name the folders whose rows changed; list those that are open.
  // Agent writes arrive as files.folders_changed instead, handled below.
  const lastRefresh = useRef(refresh);
  useEffect(() => {
    const events = refreshEvents(threadId, lastRefresh.current);
    lastRefresh.current = refresh;
    if (!events.length) return;
    for (const folder of new Set(events.flatMap((event) => event.folders)))
      if (open.has(folder)) start(folder, "first");
  }, [open, refresh, start, threadId]);

  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type !== "files.folders_changed" || message.threadId !== threadId) return;
        if (!active) return;
        for (const folder of foldersToRelist(openRef.current, message.folders, message.rescan))
          start(folder, "first");
      }),
    [client, active, start, threadId],
  );

  const watch = useMemo(() => watchedFolders(openKey.split("\0")), [openKey]);
  useEffect(() => {
    if (!online) return;
    const timer = setTimeout(() => {
      try {
        client.send({ type: "files.watch", threadId: ThreadId.parse(threadId), folders: watch });
      } catch {
        // A disconnect can race the send; the next connection sends the set again.
      }
    }, watchDelay);
    return () => clearTimeout(timer);
  }, [client, online, threadId, watch]);

  useEffect(
    () => () => {
      for (const folder of running.current.keys()) stop(folder);
      try {
        if (client.state === "ready")
          client.send({ type: "files.watch", threadId: ThreadId.parse(threadId), folders: [] });
      } catch {
        // Closed with the socket; nothing is left to watch.
      }
    },
    [client, stop, threadId],
  );

  const rows = useMemo(() => (active ? folderRows(folders, open) : []), [active, folders, open]);
  const showMore = useCallback((folder: string) => start(folder, "more"), [start]);
  const retry = useCallback((folder: string) => start(folder, "first"), [start]);
  return { rows, showMore, retry };
}
