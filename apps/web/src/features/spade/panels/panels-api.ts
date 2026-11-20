import { readSpadePanels, type SpadePanel } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";
import { segment, spadeHttp, type SpadeTarget } from "../spade-requests.ts";

/*
 * A packaged bot's panels (ADR 0200 §5.2) from its Spade: the list for its conversation, a
 * panel's page by hash (cached for good, since a hash names one page), and an action the person
 * sent from one.
 */

export const panelsKey = ["spade", "panels"] as const;

/**
 * While a panel is open its list is read again now and then, so a page `ace bot dev` saved, or an
 * update brought, takes over without a reload.
 */
const openRefresh = 10_000;

/** The panels of the bot whose conversation this is; empty while unread or for a bot with none. */
export function useBotPanels(conversation: string, open: boolean): readonly SpadePanel[] {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const query = useQuery({
    queryKey: [...panelsKey, machine, conversation],
    queryFn: async ({ signal }) =>
      readSpadePanels(
        JSON.parse(
          await spadeHttp(client, "GET", `/v1/conversations/${segment(conversation)}/panels`, {
            signal,
          }),
        ),
      ),
    refetchInterval: open ? openRefresh : false,
  });
  return query.data ?? [];
}

/** A panel's page, by the hash Spade keeps it under. */
export function usePanelPage(hash: string | undefined) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  return useQuery({
    queryKey: [...panelsKey, machine, "page", hash],
    queryFn: ({ signal }) =>
      spadeHttp(client, "GET", `/v1/panels/pages/${segment(hash ?? "")}`, { signal }),
    enabled: hash !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
  });
}

/** Sends the person's action, keyed so a retry lands once. */
export function sendPanelAction(
  target: SpadeTarget,
  conversation: string,
  panel: string,
  action: { key: string; name: string; value?: unknown },
): Promise<string> {
  return spadeHttp(
    target,
    "POST",
    `/v1/conversations/${segment(conversation)}/panels/${segment(panel)}/actions`,
    {
      body: {
        key: action.key,
        action: action.name,
        ...(action.value === undefined ? {} : { value: action.value }),
      },
    },
  );
}
