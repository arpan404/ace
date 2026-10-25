import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Machine } from "@/lib/machines.ts";

/** A thread another machine's search found for the palette's query. */
export interface MachineThreadHit {
  machine: Machine;
  threadId: string;
  title: string;
  workspaceId: string;
  at: number;
}

const none: readonly MachineThreadHit[] = [];
// Outside the hook, so the combined list keeps its identity while no reply changes.
const dataOf = <T>(each: readonly { data: T | undefined }[]) => each.map((result) => result.data);

/**
 * Threads each other online machine's own search finds for `text` (ADR 0100), asked of that
 * machine's client and cached under its host id, so one machine's hits never show as another's.
 */
export function useMachineThreadHits(
  machines: readonly Machine[],
  text: string,
): readonly MachineThreadHit[] {
  const results = useQueries({
    queries: machines.map((machine) => ({
      queryKey: ["palette-threads", machine.id, text],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        if (!machine.client) return [];
        const reply = await machine.client.request(
          { type: "search.query", scope: "threads", text, limit: 100 },
          { signal },
        );
        return reply.type === "search.results" ? reply.hits : [];
      },
      enabled: machine.client !== undefined,
    })),
    combine: dataOf,
  });
  return useMemo(() => {
    const hits = machines.flatMap((machine, index) =>
      (results[index] ?? []).map((hit): MachineThreadHit => ({
        machine,
        threadId: hit.threadId,
        title: hit.threadTitle,
        workspaceId: hit.workspaceId,
        at: hit.createdAt,
      })),
    );
    return hits.length ? hits : none;
  }, [machines, results]);
}
