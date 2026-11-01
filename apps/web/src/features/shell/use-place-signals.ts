import type { SidebarReader } from "@ace/client";
import { useSidebar, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { placeSignals, standingReader, type PlaceSignal, type PlaceSignals } from "@ace/ui-core";
import { useCallback, useMemo } from "react";
import { useOrganizer } from "@/features/organize/index.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useIsChatThread } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";

const keys: readonly SidebarKey[] = ["ids", "threads", "unconfirmed"];
const quiet: PlaceSignal = { tone: undefined, needsYou: 0 };
const none: PlaceSignals = { threads: quiet, chats: quiet };

const signalEqual = (a: PlaceSignal, b: PlaceSignal) =>
  a.tone === b.tone && a.needsYou === b.needsYou;
const signalsEqual = (a: PlaceSignals, b: PlaceSignals) =>
  signalEqual(a.threads, b.threads) && signalEqual(a.chats, b.chats);

/**
 * The rail's dots for Threads and Chats, each from its own threads (`placeSignals`), read as
 * their rows read them. A list read back from disk claims nothing until the daemon confirms it,
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
  const isChat = useIsChatThread();
  const select = useCallback(
    (reader: SidebarReader): PlaceSignals => {
      if (reader.unconfirmed) return none;
      const entries = reader.ids.flatMap((id): ThreadListEntry[] => {
        const entry = reader.thread(id);
        return entry ? [entry] : [];
      });
      return placeSignals({ entries, isChat, standing });
    },
    [isChat, standing],
  );
  return useSidebar(keys, select, signalsEqual) ?? none;
}
