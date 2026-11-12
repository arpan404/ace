import type { ClientApi } from "@ace/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { agentsKey } from "./use-spade-roster.ts";
import { oversightKey, setOversight } from "./spade-oversight-api.ts";
import { personZone } from "./spade-routines-api.ts";

/** The zone each machine's Spade was last told this window. */
const told = new WeakMap<ClientApi, string>();

/** How often the zone is looked at again while the app is open (a trip, a clock change). */
const recheckMs = 60_000;

/**
 * Tells each answering machine's Spade the person's time zone (ADR 0135): a bot's day and
 * month, for its caps and its activity, are counted in it. Told again whenever the zone
 * changes, seen on focus and once a minute, and then what was counted by day is read again
 * (spend, caps, activity). A failed attempt is tried again at the next look.
 */
export function useTellZone(clients: readonly (ClientApi | undefined)[]) {
  const cache = useQueryClient();
  useEffect(() => {
    const tell = () => {
      const zone = personZone();
      for (const client of clients) {
        if (!client || told.get(client) === zone) continue;
        const before = told.get(client);
        told.set(client, zone);
        void setOversight(client, { time_zone: zone }).then(
          () => {
            // Only a change of zone moves what was counted by day; the first word doesn't
            // (and refetching then would refresh every roster each time it is shown).
            if (before === undefined) return;
            void cache.invalidateQueries({ queryKey: agentsKey });
            void cache.invalidateQueries({ queryKey: oversightKey });
            void cache.invalidateQueries({ queryKey: ["spade", "activity"] });
          },
          () => {
            if (told.get(client) === zone) told.delete(client);
          },
        );
      }
    };
    tell();
    const timer = setInterval(tell, recheckMs);
    window.addEventListener("focus", tell);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tell);
    };
  }, [cache, clients]);
}
