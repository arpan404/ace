import { parseSpadeDigests, type SpadeDigest, type SpadeRestAction } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { segment, spadeHttp, SpadeRequestError, type SpadeTarget } from "./spade-requests.ts";

/*
 * A bot's wakes (ADR 0160) and digests (ADR 0165), as the chat acts on and shows them
 * (spade/docs/oversight.md). The wakes themselves come from the conversation's events.
 */

/**
 * Wake the bot now (Wake now, Try now) or call its wake off (Cancel). A wake that is no longer
 * open (`409`: it fired or was cancelled meanwhile) is what the person wanted: not an error.
 */
export async function actOnWake(
  target: SpadeTarget,
  agent: string,
  wake: string,
  action: SpadeRestAction,
): Promise<void> {
  const path = `/v1/agents/${segment(agent)}/wakes/${segment(wake)}`;
  try {
    if (action === "cancel") await spadeHttp(target, "DELETE", path);
    else await spadeHttp(target, "POST", `${path}/wake`, { body: {} });
  } catch (error) {
    if (!(error instanceof SpadeRequestError && error.status === 409)) throw error;
  }
}

export async function readDigests(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", `/v1/digests?agent=${segment(agent)}`, { signal });
  const digests = parseSpadeDigests(body);
  if (!digests) throw new Error("Spade's digests didn't make sense.");
  return digests;
}

const none: readonly SpadeDigest[] = [];

/**
 * The bot's digests, oldest first, for its chat. One a day by default, so read on arrival and
 * when the window comes back; none while they can't be read (the chat goes on without them).
 */
export function useSpadeDigests(agent: string): readonly SpadeDigest[] {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const digests = useQuery({
    queryKey: ["spade", "digests", machine, agent],
    queryFn: ({ signal }) => readDigests(client, agent, signal),
    staleTime: 60_000,
    retry: false,
  });
  return digests.data ?? none;
}
