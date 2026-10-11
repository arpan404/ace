import { useClient } from "@ace/client-react";
import { useEffect } from "react";
import { loadedPanelServices } from "../services.ts";
import { bindTerminalEndDelivery, endPanelTerminal } from "./end-delivery.ts";
import { onTerminalEnd, setTerminalProbe } from "./closing.ts";

/**
 * Binds the tab kinds' terminal questions to the client whose screen shows: closed tabs end
 * their shells through it, and whether a shell has already exited is asked of it alone. Drawn
 * once per screen (the terminal kind's overlay); a client that goes away stops answering.
 */
export function TerminalClient() {
  const client = useClient();
  useEffect(() => {
    const delivery = bindTerminalEndDelivery(client);
    const unprobe = setTerminalProbe((threadId, terminalId) => {
      // Not loaded: this client never attached the terminal, so it can't say it ended.
      const terminals = loadedPanelServices(client)?.terminals;
      if (!terminals) return undefined;
      if (terminals.exitCode(terminalId) !== null) return true;
      return terminals.source.list(threadId).find((terminal) => terminal.id === terminalId)?.exited;
    });
    // A closed terminal tab ends its shell (the tab kind's onClose has no client to ask).
    const unend = onTerminalEnd((end) => endPanelTerminal(client, end));
    return () => {
      unprobe();
      unend();
      delivery.release();
    };
  }, [client]);
  return null;
}
