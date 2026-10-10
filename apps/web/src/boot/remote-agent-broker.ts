import { brokerLeader } from "./broker-leader.ts";
import type { ClientApi } from "@ace/client";
import type { MachinePool } from "@ace/client-worker/machines";
import { useDaemonConnection } from "./connection.tsx";
import { useEffect } from "react";

/** Load the broker only for actual paired-device connections, alongside their worker pool. */
export function useRemoteAgentBroker(primary: ClientApi, pool: MachinePool | undefined): void {
  const { url } = useDaemonConnection();
  useEffect(() => {
    if (!pool) return;
    if (!navigator.locks) return startRemoteAgentBroker(primary, pool);
    return brokerLeader(navigator.locks, url, () => startRemoteAgentBroker(primary, pool));
  }, [primary, pool, url]);
}

function startRemoteAgentBroker(primary: ClientApi, pool: MachinePool): () => void {
  let live = true;
  let close: (() => void) | undefined;
  void import("@ace/client-worker/remote-agent-broker").then(({ RemoteAgentBroker }) => {
    if (!live) return;
    const broker = new RemoteAgentBroker({
      primary,
      pool,
      now: Date.now,
      scheduler: {
        set(ms, fn) {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
      },
    });
    close = () => broker.close();
    broker.start();
  });
  return () => {
    live = false;
    close?.();
  };
}
