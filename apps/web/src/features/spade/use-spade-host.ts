import type { ClientApi } from "@ace/client";
import { spadeHostSync } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { primaryMachineId } from "@/lib/machines.ts";
import { offerHost } from "./spade-move-api.ts";
import { agentsKey, mainKey, type SpadeHosting } from "./use-spade-roster.ts";

/** The records this window already offered each machine's Spade, once per window. */
const offeredTo = new WeakMap<ClientApi, Set<string>>();

/**
 * Keeps the fleet's choice of where Spade lives in step (ADR 0187): copies the newest host record
 * to every machine that holds an older one (the machine it names first: the others check it
 * there), and writes the first record once when no machine has one, naming the Spade the person
 * already has. It never switches a machine's Spade off and never
 * picks a new host: only the person and a move do. Run once per window, by the Spade panel.
 */
export function useSpadeHost({ machines, fresh, mains, settled }: SpadeHosting) {
  const cache = useQueryClient();
  // A first choice this window writes keeps one time, so writing it again is the same record,
  // offered once, never a second, newer one.
  const seededAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    const seen = machines.flatMap((machine, index) => {
      const agents = fresh[index];
      const main = mains[index];
      if (!agents || !main || !machine.client) return [];
      return [
        {
          client: machine.client,
          host: machine.id,
          record: main.host,
          main: agents.find((agent) => agent.kind === "main"),
        },
      ];
    });
    // Windows agree only once every machine is named by its host id.
    if (seen.length === 0 || seen.some((entry) => entry.host === primaryMachineId)) return;
    const own = machines.find((machine) => machine.primary)?.id ?? primaryMachineId;
    const everyAnswered = machines.every(
      (machine, index) =>
        !machine.client || mains[index] !== undefined || fresh[index] === undefined,
    );
    seededAt.current ??= Date.now();
    const sync = spadeHostSync(seen, settled && everyAnswered, own, seededAt.current);
    const choice = sync.choice;
    if (!choice) return;
    const key = `${choice.host}@${choice.version}@${choice.at}`;
    // The machine the record names first: each other machine keeps it only once that one holds
    // it, so they hear it on a later pass.
    const tell = sync.tell.includes(choice.host) ? [choice.host] : sync.tell;
    for (const host of tell) {
      const entry = seen.find((candidate) => candidate.host === host);
      if (!entry) continue;
      const offered = offeredTo.get(entry.client) ?? new Set<string>();
      offeredTo.set(entry.client, offered);
      if (offered.has(key)) continue;
      offered.add(key);
      void offerHost(entry.client, choice).then(
        () => {
          void cache.invalidateQueries({ queryKey: agentsKey });
          void cache.invalidateQueries({ queryKey: mainKey });
        },
        () => offered.delete(key),
      );
    }
  }, [machines, fresh, mains, settled, cache]);
}
