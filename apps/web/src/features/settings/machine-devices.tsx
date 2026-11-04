import { formatAgo, formatCountdown } from "@ace/ui-core";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import {
  HairlineList,
  HairlineRow,
  RowAction,
  RowGroup,
  RowTile,
} from "@/components/hairline-row.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useMachinePool } from "@/lib/machine-pool.ts";
import type { Machine } from "@/lib/machines.ts";
import { useNow } from "@/lib/time.ts";
import { fleetProblem, revokeDevice } from "./data/fleet.ts";
import { linkDeviceIds } from "./data/fleet-links.ts";
import type { Fleet } from "./data/use-fleet.ts";
import { deviceScopeLabels } from "./device-scopes.ts";
import { DeviceGlyph } from "./fleet-devices.tsx";
import { PairDevice } from "./pair-device.tsx";

/** The phones, tablets and browsers paired to this machine, each removable here alone. */
export function MachineDevices(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const now = useNow();
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>();
  const query = fleet.devices.get(machine.id);
  const links = linkDeviceIds(fleet.facts);
  const devices = (query?.data ?? []).filter((device) => !links.has(device.id));
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      if (!machine.client) throw new Error(`${machine.name} is offline.`);
      await revokeDevice(machine.client, id);
      await fleet.refresh([machine.id]);
    },
    onError: (error) => toast.error({ title: "Couldn't remove it", description: error.message }),
  });
  if (!machine.client) return null;
  return (
    <RowGroup
      label="Devices that open it"
      count={devices.length}
      anchor="devices"
      actions={<PairDevice machine={machine.id} variant="ghost" />}
    >
      {query?.isError && (
        <p role="alert" className="py-2.5 text-xs text-muted-foreground">
          {fleetProblem(query.error)}
        </p>
      )}
      {query?.isSuccess && devices.length === 0 && (
        <p className="py-2.5 text-xs text-muted-foreground">No paired devices.</p>
      )}
      {devices.map((device) => {
        const expires = device.expiresAt ?? null;
        return (
          <HairlineRow
            key={device.id}
            tile={
              <RowTile>
                <DeviceGlyph name={device.name} />
              </RowTile>
            }
            title={device.name}
            tag={device.self ? "this device" : undefined}
            sub={[
              `Paired · ${deviceScopeLabels(device.scopes).toLowerCase()}`,
              expires === null
                ? undefined
                : expires <= now
                  ? "expired"
                  : `expires in ${formatCountdown(expires - now)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
            meta={formatAgo(device.lastSeenAt, now)}
            actions={
              <RowAction
                reveal
                aria-label={`Remove ${device.name}`}
                disabled={revoke.isPending}
                onClick={() =>
                  setConfirming({
                    title: `Remove ${device.name}?`,
                    body: `It disconnects from ${machine.name} at once and has to be paired again.`,
                    confirm: "Remove",
                    run: () => revoke.mutate(device.id),
                  })
                }
              >
                Remove
              </RowAction>
            }
          />
        );
      })}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </RowGroup>
  );
}

/**
 * Taking a machine out of the fleet: asks first, unlinks it from every machine both ways that
 * can be reached, then forgets it here. Its threads stay on it; it can be added again with a
 * fresh pairing link. `ask` opens the question; render `dialog` beside the button.
 */
export function useRemoveMachine(
  machine: Machine,
  fleet: Fleet,
  options: { onRemoved?: () => void } = {},
) {
  const pool = useMachinePool();
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>();
  const remove = useMutation({
    mutationFn: async () => {
      const others = fleet.machines.filter((entry) => entry.id !== machine.id);
      // Unlink what can be reached now; an offline machine's own side can't be, and forgetting it
      // here still takes it out of this window's fleet.
      const unlinked = await fleet.unlink.mutateAsync({ machine, others }).then(
        () => true,
        () => false,
      );
      await pool?.remove(machine.id);
      return unlinked;
    },
    onSuccess: (unlinked) => {
      toast.add({
        title: `${machine.name} removed from the fleet`,
        ...(unlinked
          ? {}
          : { description: "Some links couldn't be undone while a machine was offline." }),
      });
      options.onRemoved?.();
    },
    onError: (error) => toast.error({ title: "Couldn't remove it", description: error.message }),
  });
  return {
    pending: remove.isPending,
    ask: () =>
      setConfirming({
        title: `Remove ${machine.name} from the fleet?`,
        body: "Agents stop using it and it stops using the others. Add it again with a fresh pairing link.",
        confirm: "Remove",
        run: () => remove.mutate(),
      }),
    dialog: <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />,
  };
}

/** The machine page's Remove row. */
export function RemoveMachine(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const navigate = useNavigate();
  const remove = useRemoveMachine(machine, fleet, {
    onRemoved: () => void navigate({ to: "/settings/remote" }),
  });
  return (
    <section id="remove" aria-label="Remove" className="mt-8">
      <HairlineList>
        <HairlineRow
          title={`Remove ${machine.name} from your fleet`}
          sub={`Its links end and this window forgets it. ${machine.name} keeps its threads.`}
          actions={
            <RowAction tone="danger" disabled={remove.pending} onClick={remove.ask}>
              Remove
            </RowAction>
          }
        />
      </HairlineList>
      {remove.dialog}
    </section>
  );
}
