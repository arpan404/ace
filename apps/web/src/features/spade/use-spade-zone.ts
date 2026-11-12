import type { ClientApi } from "@ace/client";
import { useEffect } from "react";
import { setOversight } from "./spade-oversight-api.ts";
import { personZone } from "./spade-routines-api.ts";

/** Each machine's Spade this window told the person's zone, once per window. */
const told = new WeakSet<ClientApi>();

/**
 * Tells each answering machine's Spade the person's time zone once (ADR 0135): a bot's day and
 * month, for its caps and its activity, are counted in it. A failed attempt is tried again the
 * next time the list changes.
 */
export function useTellZone(clients: readonly (ClientApi | undefined)[]) {
  useEffect(() => {
    for (const client of clients) {
      if (!client || told.has(client)) continue;
      told.add(client);
      void setOversight(client, { time_zone: personZone() }).catch(() => told.delete(client));
    }
  }, [clients]);
}
