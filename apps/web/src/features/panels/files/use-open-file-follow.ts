import { useClient, useConnectionState } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { watchFolders } from "./folder-watch.ts";

/** The folder a checkout path sits in, as `files.watch` names it ("" is the root). */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Keep an open checkout file in step with its disk copy when something outside ace writes it
 * (another editor, a shell, a build). The file's folder joins the thread's watch set, so the
 * daemon names it in `files.folders_changed` whether or not a tree shows it, and that notice reads
 * the file again. An edit in progress keeps its own text; saving it over the newer copy is the
 * editor's conflict.
 */
export function useOpenFileFollow(threadId: string, path: string | undefined): void {
  const client = useClient();
  const queries = useQueryClient();
  const online = useConnectionState() === "ready";
  const folder = path === undefined ? undefined : folderOf(path);

  const watch = useMemo(() => watchFolders(client, threadId), [client, threadId]);
  useEffect(() => () => watch.leave(), [watch]);
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) watch.resume();
    wasOnline.current = online;
  }, [online, watch]);
  // The file may have been read before its folder was watched (or while offline, or while the
  // tab was hidden), and a write in that gap names no folder: once the daemon is watching the
  // folder, the file is read once more.
  useEffect(() => {
    if (path === undefined || folder === undefined) {
      watch.set([]);
      return;
    }
    let unconfirmed = true;
    const stop = watch.listen((folders) => {
      if (!unconfirmed || !folders.includes(folder)) return;
      unconfirmed = false;
      void queries.invalidateQueries({ queryKey: ["checkout", "file", threadId, path] });
    });
    watch.set([folder]);
    return stop;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- coming back online is a new gap to read past.
  }, [watch, queries, threadId, path, folder, online]);

  useEffect(() => {
    if (path === undefined || folder === undefined) return;
    return client.onMessage((message) => {
      if (message.type !== "files.folders_changed" || message.threadId !== threadId) return;
      if (!message.rescan && !message.folders.includes(folder)) return;
      void queries.invalidateQueries({ queryKey: ["checkout", "file", threadId, path] });
    });
  }, [client, queries, threadId, path, folder]);
}
