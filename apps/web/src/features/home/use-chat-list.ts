import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import {
  chatList,
  chatRows,
  isRemoved,
  threadMatches,
  withChatHits,
  type ChatList,
  type HomeRow,
} from "@ace/ui-core";
import { useCallback, useMemo } from "react";
import { machineRow } from "@/lib/machine-threads.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { useIsChat, useIsChatThread } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { useEntries, useEveryEntryKey, useStandingOf } from "./use-home-threads.ts";
import { useThreadHits, type SearchHit } from "./use-panel-search.ts";

/** The Chats panel's list now: its rows, and what the shared thread list needs beside them. */
export interface ChatsView {
  rows: readonly HomeRow[];
  pinned: readonly string[];
  needsYou: readonly string[];
  /** Search hits for older chats the list hasn't loaded, which their rows draw from. */
  hits: ReadonlyMap<string, SearchHit>;
  /** Whether any chat is listed before the search narrows it. */
  any: boolean;
}

interface Selected {
  list: ChatList;
  any: boolean;
}

const noList: ChatList = { pinned: [], dated: [], settled: [], needsYou: [] };
const none: Selected = { list: noList, any: false };
const noHits: ReadonlyMap<string, SearchHit> = new Map();
const noOthers: readonly ThreadListEntry[] = [];

const selectedEqual = (a: Selected, b: Selected) =>
  a.any === b.any &&
  arrayEqual(a.list.pinned, b.list.pinned) &&
  arrayEqual(a.list.settled, b.list.settled) &&
  arrayEqual(a.list.needsYou, b.list.needsYou) &&
  a.list.dated.length === b.list.dated.length &&
  a.list.dated.every((item, i) => {
    const other = b.list.dated[i];
    return other !== undefined && item.id === other.id && item.day === other.day;
  });

/**
 * Every chat (ADR 0099), pinned ones first, the rest by the day they last moved (`chatList`):
 * this machine's, and `others`, other machines' chats under their machine row ids
 * (`useMachineEntries`, ADR 0102). `device` narrows them to one machine. `query` narrows them
 * by title, and this daemon's thread search (scoped to chats here, since it can only scope to
 * one project) adds matching older chats the list hasn't paged in, and loaded ones whose
 * messages match; as in Threads, it isn't asked while another device is chosen. Only ids are
 * selected, so a status change re-renders its own row.
 */
export function useChatList(
  query: string,
  others: readonly ThreadListEntry[] = noOthers,
  device?: string | undefined,
): ChatsView {
  const keys = useEveryEntryKey();
  const read = useEntries();
  const now = useNow();
  const standing = useStandingOf(now);
  const isChatThread = useIsChatThread();
  const isChatProject = useIsChat();
  const text = query.trim();
  const ownDevice = usePrimaryMachine().id;
  const offDevice = device !== undefined && device !== ownDevice;
  const asked = useThreadHits(text);
  const found = offDevice ? noHits : asked;
  const select = useCallback(
    (reader: SidebarReader): Selected => {
      const own = read(reader);
      const merged = others.length ? [...own, ...others] : own;
      const entries = device
        ? merged.filter((entry) => (machineRow(entry.id)?.hostId ?? ownDevice) === device)
        : merged;
      const unconfirmed = reader.unconfirmed;
      const standingOf = unconfirmed
        ? () => ({ level: "syncing" as const, done: false })
        : standing;
      const isChat = isChatThread;
      const all = chatList({ entries, isChat, standing: standingOf, now });
      if (!text) return { list: all, any: all.pinned.length + all.dated.length > 0 };
      const shown = entries.filter(
        (entry) => threadMatches(entry, text, "Chat") || found.has(entry.id),
      );
      const narrowed = chatList({ entries: shown, isChat, standing: standingOf, now });
      // Older chats the daemon found that the list hasn't loaded (or holds archived) join by date.
      const older: { id: string; at: number }[] = [];
      for (const [id, hit] of found) {
        const entry = reader.thread(id);
        if (entry ? isRemoved(entry) || !isChatThread(entry) : !isChatProject(hit.workspaceId))
          continue;
        if (!entry) older.push({ id, at: hit.createdAt });
      }
      return {
        list: withChatHits(narrowed, older, now),
        any: all.pinned.length + all.dated.length > 0,
      };
    },
    [read, standing, isChatThread, isChatProject, now, text, found, others, device, ownDevice],
  );
  const selected = useSidebar(keys, select, selectedEqual) ?? none;
  return useMemo(
    () => ({
      rows: chatRows(selected.list),
      pinned: selected.list.pinned,
      needsYou: selected.list.needsYou,
      hits: text ? found : noHits,
      any: selected.any,
    }),
    [selected, text, found],
  );
}
