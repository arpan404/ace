import type { SidebarReader } from "@ace/client";
import { useSidebar, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import {
  addAttention,
  placeAttention,
  placeReader,
  placeSignals,
  standingReader,
  type PlaceSignal,
  type PlaceSignals,
} from "@ace/ui-core";
import { useCallback, useMemo } from "react";
import { useOrganizer, useOverlaidMachineEntries } from "@/features/organize/index.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useMachineEntries } from "@/lib/machine-threads.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useIsChatThread } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";

const keys: readonly SidebarKey[] = ["ids", "threads", "homeWindow", "unconfirmed"];
const quiet: PlaceSignal = { tone: undefined, needsYou: 0 };
const none: PlaceSignals = { threads: quiet, chats: quiet };

const signalEqual = (a: PlaceSignal, b: PlaceSignal) =>
  a.tone === b.tone && a.needsYou === b.needsYou;
const signalsEqual = (a: PlaceSignals, b: PlaceSignals) =>
  signalEqual(a.threads, b.threads) && signalEqual(a.chats, b.chats);

/**
 * The rail's dots for Threads and Chats on every connected machine (ADR 0102): this machine's
 * as its daemon sends them with the list (`ThreadListWindow.attention`), each other machine's
 * from what its places list (`placeAttention`, the same rule). An older daemon's list is worked
 * out the same way. A list read back from disk claims nothing until the daemon confirms it,
 * since its requests may have been answered since. Re-renders only when a dot changes.
 */
export function usePlaceSignals(): PlaceSignals {
  const models = useModelCatalog();
  const { baseline } = useOrganizer().getState();
  const now = useNow();
  const standing = useMemo(
    () => standingReader({ baseline, now, models }),
    [baseline, now, models],
  );
  const place = useMemo(
    () => placeReader({ fallback: { baseline, now, models } }),
    [baseline, now, models],
  );
  const isChat = useIsChatThread();
  const others = useOverlaidMachineEntries(useMachineEntries(useHostIdentity()?.hostId));
  const select = useCallback(
    (reader: SidebarReader): PlaceSignals => {
      if (reader.unconfirmed) return none;
      const of = (entries: Iterable<ThreadListEntry>) =>
        placeAttention({ entries, isChat, place, standing });
      const own =
        reader.homeWindow?.attention ??
        of(
          reader.ids.flatMap((id): ThreadListEntry[] => {
            const entry = reader.thread(id);
            return entry ? [entry] : [];
          }),
        );
      return placeSignals(others.length ? addAttention(own, of(others)) : own);
    },
    [isChat, standing, place, others],
  );
  return useSidebar(keys, select, signalsEqual) ?? none;
}
