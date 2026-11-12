import {
  BrowserIcon,
  DeviceMobileIcon,
  DeviceTabletIcon,
  LinkSimpleIcon,
} from "@phosphor-icons/react";
import { formatAgo, formatCountdown, listNames } from "@ace/ui-core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { HairlineRow, RowAction, RowGroup, RowTile } from "@/components/hairline-row.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { deviceKind, removeDeviceQuestion, type FleetDevice } from "@ace/ui-core/fleet-map";
import { cancelPairing, deviceLifetimes, revokeDevice } from "./data/fleet.ts";
import type { Fleet } from "./data/use-fleet.ts";
import { deviceScopeLabels } from "./device-scopes.ts";

/** A device's glyph from the name it gives: phones, tablets, else a browser. */
const glyphs = { tablet: DeviceTabletIcon, phone: DeviceMobileIcon, browser: BrowserIcon };

export function DeviceGlyph(props: { name: string }) {
  const Glyph = glyphs[deviceKind(props.name)];
  return <Glyph aria-hidden size={15} />;
}

/** Where a device is paired, in words: "Every machine" when it's on all of them. */
function machinesLine(device: FleetDevice, fleet: Fleet): string {
  if (fleet.machines.length > 1 && device.on.length === fleet.machines.length)
    return "Every machine";
  return listNames(device.on.map((entry) => fleet.byId(entry.machine)?.name ?? "A machine"));
}

/** Its access in the row's words, or that it differs, since each machine holds its own grant. */
export function accessWords(labels: readonly string[]): string {
  const unique = new Set(labels);
  const [only] = unique;
  return unique.size === 1 && only ? only.toLowerCase() : "access differs by machine";
}

function expiryLine(expiresAt: number | null, now: number): string | undefined {
  if (expiresAt === null) return undefined;
  return expiresAt <= now ? "expired" : `expires in ${formatCountdown(expiresAt - now)}`;
}

/**
 * Removing a device from every machine it's paired with: asks first (warning when it's the
 * device this window connects as), then revokes it on each. `ask` opens the question; render
 * `dialog` beside the button.
 */
export function useRemoveDevice(fleet: Fleet) {
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>();
  const revoke = useMutation({
    mutationFn: async (targets: FleetDevice["on"]) => {
      for (const target of targets) {
        const client = fleet.byId(target.machine)?.client;
        if (!client) throw new Error("Connect to that machine to remove the device there.");
        await revokeDevice(client, target.device.id);
      }
      await fleet.refresh(targets.map((target) => target.machine));
    },
    onError: (error) => toast.error({ title: "Couldn't remove it", description: error.message }),
  });
  return {
    pending: revoke.isPending,
    ask: (device: FleetDevice) =>
      setConfirming({
        ...removeDeviceQuestion(device, "This window"),
        run: () => revoke.mutate(device.on),
      }),
    dialog: <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />,
  };
}

/**
 * The phones, tablets and browsers paired with the fleet's machines, the same device on several
 * machines as one row, each removable. Then the pairing links nobody has used yet, each
 * cancellable. Nothing at all while there are neither.
 */
export function FleetDevices(props: { fleet: Fleet }) {
  const { fleet } = props;
  const now = useNow();
  const toast = useToast();
  const remove = useRemoveDevice(fleet);
  const failed = fleet.machines.flatMap((machine) =>
    fleet.devices.get(machine.id)?.isError ? [machine.name] : [],
  );
  const open = fleet.machines.flatMap((machine) =>
    (fleet.pairings.get(machine.id)?.data ?? [])
      .filter((pairing) => pairing.expiresAt > now)
      .map((pairing) => ({ machine, pairing })),
  );
  const cancel = useMutation({
    mutationFn: async (entry: (typeof open)[number]) => {
      if (!entry.machine.client) throw new Error(`${entry.machine.name} is offline.`);
      await cancelPairing(entry.machine.client, entry.pairing.id);
      await fleet.pairings.get(entry.machine.id)?.refetch();
    },
    onError: (error) => toast.error({ title: "Couldn't cancel", description: error.message }),
  });
  if (fleet.joined.length === 0 && open.length === 0 && failed.length === 0) return null;
  return (
    <RowGroup label="Devices" count={fleet.joined.length} anchor="fleet-devices">
      {failed.length > 0 && (
        <p role="alert" className="py-2.5 text-xs text-muted-foreground">
          Couldn't read the devices on {listNames(failed)}.
        </p>
      )}
      {fleet.joined.map((device) => (
        <HairlineRow
          key={device.key}
          tile={
            <RowTile>
              <DeviceGlyph name={device.name} />
            </RowTile>
          }
          title={device.name}
          tag={device.self ? "this device" : undefined}
          sub={[
            machinesLine(device, fleet),
            accessWords(device.on.map((entry) => deviceScopeLabels(entry.device.scopes))),
            expiryLine(device.expiresAt, now),
          ]
            .filter(Boolean)
            .join(" · ")}
          meta={formatAgo(device.lastSeenAt, now)}
          actions={
            <RowAction
              reveal
              aria-label={`Remove ${device.name}`}
              disabled={remove.pending}
              onClick={() => remove.ask(device)}
            >
              Remove
            </RowAction>
          }
        />
      ))}
      {open.map(({ machine, pairing }) => {
        const keeps = deviceLifetimes.find((entry) => entry.value === (pairing.deviceTtlMs ?? 0));
        return (
          <HairlineRow
            key={`${machine.id}:${pairing.id}`}
            data-row="pairing-link"
            tile={
              <RowTile>
                <LinkSimpleIcon aria-hidden size={15} />
              </RowTile>
            }
            title={pairing.label ? `Pairing link for ${pairing.label}` : "Pairing link waiting"}
            sub={[
              `Expires in ${formatCountdown(pairing.expiresAt - now)}`,
              fleet.machines.length > 1 ? machine.name : undefined,
              deviceScopeLabels(pairing.scopes).toLowerCase(),
              pairing.deviceTtlMs ? `access for ${keeps?.label ?? "a while"}` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
            actions={
              <RowAction
                aria-label={`Cancel ${pairing.label ? `the link for ${pairing.label}` : "the pairing link"}`}
                disabled={cancel.isPending}
                onClick={() => cancel.mutate({ machine, pairing })}
              >
                Cancel
              </RowAction>
            }
          />
        );
      })}
      {remove.dialog}
    </RowGroup>
  );
}
