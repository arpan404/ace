import type { ConnectionState, Intent } from "@ace/client";
import type { CommandPayload } from "@ace/protocol";
import { useCallback, useMemo, useState } from "react";
import { useClient } from "./context.ts";
import { useSelection } from "./selection.ts";

export function useConnectionState(): ConnectionState {
  const client = useClient();
  const selection = useMemo(() => client.connectionState(), [client]);
  return useSelection(selection) ?? client.state;
}
export function useIntent(id: string | undefined): Intent | undefined {
  const client = useClient();
  const selection = useMemo(() => (id ? client.intent(id) : undefined), [client, id]);
  return useSelection(selection);
}
/**
 * Send a durable intent and follow its receipt. Acked means the daemon accepted the
 * command; the effect itself arrives through the live stores.
 */
export function useIntentSender(): {
  send(payload: CommandPayload): Promise<string>;
  intent: Intent | undefined;
  error: unknown;
} {
  const client = useClient();
  const [id, setId] = useState<string>();
  const [error, setError] = useState<unknown>();
  const intent = useIntent(id);
  const send = useCallback(
    async (payload: CommandPayload) => {
      setError(undefined);
      try {
        const sent = await client.enqueue(payload);
        setId(sent);
        return sent;
      } catch (caught) {
        setError(caught);
        throw caught;
      }
    },
    [client],
  );
  return { send, intent, error };
}
