import { useEffect } from "react";

import { beginLoadPhase, logLoadDiagnostic } from "../loadDiagnostics";
import { getWsRpcClient } from "../wsRpcClient";
import { startServerStateSync } from "./serverState";

export function ServerStateBootstrap() {
  useEffect(() => {
    const phase = beginLoadPhase("server-state", "Bootstrapping server state sync");
    const cleanup = startServerStateSync(getWsRpcClient().server);
    phase.success("Server state sync subscriptions active");
    return () => {
      logLoadDiagnostic({ phase: "server-state", message: "Disposing server state sync" });
      cleanup();
    };
  }, []);

  return null;
}
