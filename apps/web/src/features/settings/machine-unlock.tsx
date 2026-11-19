import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  MachineCodePrompt,
  useAccountMachineConnector,
  type AccountMachineConnection,
  type AccountMachineState,
} from "@/features/ace-account/index.ts";
import { useMachinePool } from "@/lib/machine-pool.ts";
import type { Machine } from "@/lib/machines.ts";

const idle = () => () => {};

/**
 * A machine page's one action, when it has one: Unlock for an account machine that asks for its
 * machine code (the prompt then opens under the title), Reconnect for one that's offline.
 * `unlock` starts the same as the button, for a caller drawing its own.
 */
export function useMachineAction(machine: Machine) {
  const pool = useMachinePool();
  const connector = useAccountMachineConnector();
  const [connection, setConnection] = useState<AccountMachineConnection>();
  const [problem, setProblem] = useState("");
  const state = useSyncExternalStore<AccountMachineState | undefined>(
    connection?.subscribe ?? idle,
    () => connection?.get(),
  );
  const unlock = () => {
    if (!connector) return;
    setProblem("");
    connector
      .connect({ hostId: machine.id, name: machine.name, platform: "" })
      .then(setConnection, (error: unknown) =>
        setProblem(error instanceof Error ? error.message : "Couldn't open it. Try again."),
      );
  };
  const button =
    machine.primary ||
    machine.status === "online" ||
    machine.status === "connecting" ? null : machine.status === "machine_code" ? (
      connector &&
      !connection && (
        <Button size="sm" variant="primary" onClick={unlock}>
          Unlock
        </Button>
      )
    ) : (
      <Button size="sm" variant="secondary" onClick={() => pool?.reconnect(machine.id)}>
        Reconnect
      </Button>
    );
  const prompt =
    connection && state?.kind === "asking" ? (
      <MachineCodePrompt
        gate={connection.gate}
        machine={machine.name}
        lockedUntil={state.lockedUntil}
        onEntered={() => connection.retry()}
      />
    ) : problem ? (
      <p role="alert" className="text-xs text-destructive">
        {problem}
      </p>
    ) : null;
  return { button, prompt, unlock, canUnlock: connector !== undefined && !connection };
}
