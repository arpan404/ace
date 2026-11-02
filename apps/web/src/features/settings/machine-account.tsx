import { useMemo } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { MachineAccountSections, type MachineAccountAccess } from "@/features/ace-account/index.ts";
import type { Machine } from "@/lib/machines.ts";
import { machineAccountSource } from "./data/machine-account-source.ts";
import { useSettingsBackend } from "./data/use-settings.ts";

/**
 * A machine's ace account and machine code on its Settings page.
 *
 * TODO(ace/relay-main-conversation): another machine's code needs the wire messages that read,
 * set and clear it over that machine's channel; until they land only this window's own daemon,
 * reached over its HTTP routes, shows these sections.
 */
function useMachineAccountAccess(machine: Machine): MachineAccountAccess | undefined {
  const backend = useSettingsBackend();
  const { endpoint } = useDaemonConnection();
  return useMemo(
    () =>
      machine.primary ? machineAccountSource(endpoint, () => backend.remoteStatus()) : undefined,
    [machine.primary, endpoint, backend],
  );
}

export function MachineAccount(props: { machine: Machine }) {
  const access = useMachineAccountAccess(props.machine);
  if (!access) return null;
  return (
    <MachineAccountSections
      machine={props.machine.id}
      access={access}
      local={props.machine.primary}
    />
  );
}
