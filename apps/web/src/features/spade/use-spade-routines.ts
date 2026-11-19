import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readHeartbeat, readRoutines } from "./spade-routines-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

/** Every routines read; one bot's under `[...routinesKey, machine key, agent id]`. */
export const routinesKey = ["spade", "routines"] as const;

/** A bot's routines and heartbeat on the machine in scope, kept fresh while shown. */
export function useSpadeRoutines(agent: string) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const key = [...routinesKey, machine, agent];
  const cache = useQueryClient();
  // Next runs and last results change as routines fire.
  const refetchInterval = 30_000;
  const routines = useQuery({
    queryKey: [...key, "list"],
    queryFn: ({ signal }) => readRoutines(client, agent, signal),
    refetchInterval,
  });
  const heartbeat = useQuery({
    queryKey: [...key, "heartbeat"],
    queryFn: ({ signal }) => readHeartbeat(client, agent, signal),
    refetchInterval,
  });
  return {
    routines,
    heartbeat,
    client,
    refresh: () => cache.invalidateQueries({ queryKey: key }),
  };
}
