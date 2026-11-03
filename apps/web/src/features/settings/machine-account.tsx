import { useMemo } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { MachineAccountSections, type MachineAccountAccess } from "@/features/ace-account/index.ts";
import type { Machine } from "@/lib/machines.ts";
import { machineAccountSource } from "./data/machine-account-source.ts";
import { machineCodeAdminSource } from "./data/machine-code-admin-source.ts";
import { useSettingsBackend } from "./data/use-settings.ts";

/**
 * A machine's ace account and machine code on its Settings page: this window's own daemon, which
 * this computer may also sign in and out, and any other connected machine's code, each over its
 * own connection. A machine that is offline, or where this device isn't an admin, shows nothing.
 */
function useMachineAccountAccess(machine: Machine): MachineAccountAccess | undefined {
  const backend = useSettingsBackend();
  const { endpoint } = useDaemonConnection();
  return useMemo(
    () =>
      machine.primary
        ? machineAccountSource(endpoint, () => backend.remoteStatus(), machine.client)
        : machine.client
          ? machineCodeAdminSource(machine.client)
          : undefined,
    [machine.primary, machine.client, endpoint, backend],
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
