import { formatAgo, formatCountdown } from "@ace/ui-core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { RowMenu } from "@/components/ui/row-menu.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { cancelPairing, deviceLifetimes, revokeDevice } from "./data/fleet.ts";
import type { FleetDevice } from "./data/fleet-links.ts";
import type { Fleet } from "./data/use-fleet.ts";
import { deviceScopeLabels } from "./device-scopes.ts";
import { ConfirmDialog, type Confirming } from "./confirm-dialog.tsx";
import { listNames } from "./data/list-names.ts";
import { PairDevice } from "./pair-device.tsx";

/** Where a device is paired, in words: "All machines" when it's on every one. */
function machinesLine(device: FleetDevice, fleet: Fleet): string {
  if (fleet.machines.length > 1 && device.on.length === fleet.machines.length)
    return "All machines";
  return listNames(device.on.map((entry) => fleet.byId(entry.machine)?.name ?? "A machine"));
}

/** Its access, or that it differs, since each machine holds its own grant. */
function accessLine(device: FleetDevice): string {
  const labels = new Set(device.on.map((entry) => deviceScopeLabels(entry.device.scopes)));
  const [only] = labels;
  return labels.size === 1 && only ? only : "Access differs by machine";
}

function expiryLine(expiresAt: number | null, now: number): string | undefined {
  if (expiresAt === null) return undefined;
  return expiresAt <= now ? "Expired" : `Expires in ${formatCountdown(expiresAt - now)}`;
}

/**
 * The phones, tablets and browsers paired with the fleet's machines: the same device on several
 * machines is one row. Then the pairing links nobody has used yet, each cancellable.
 */
export function FleetDevices(props: { fleet: Fleet }) {
  const { fleet } = props;
  const now = useNow();
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>();
  const loading = fleet.machines.some((machine) => fleet.devices.get(machine.id)?.isPending);
  const failed = fleet.machines.flatMap((machine) => {
    const query = fleet.devices.get(machine.id);
    return query?.isError ? [machine.name] : [];
  });
  const revoke = useMutation({
    mutationFn: async (targets: FleetDevice["on"]) => {
      for (const target of targets) {
        const client = fleet.byId(target.machine)?.client;
        if (!client) throw new Error("Connect to that machine to revoke the device there.");
        await revokeDevice(client, target.device.id);
      }
      await fleet.refresh(targets.map((target) => target.machine));
    },
    onError: (error) => toast.error({ title: "Couldn't revoke", description: error.message }),
  });
  const confirmRevoke = (device: FleetDevice, targets: FleetDevice["on"]) =>
    setConfirming({
      title: `Revoke ${device.name}?`,
      body: device.self
        ? "This is the device you're using. This window disconnects at once and has to be paired again."
        : targets.length === device.on.length
          ? "It disconnects at once and has to be paired again to see or control threads."
          : `It disconnects from ${listNames(targets.map((target) => fleet.byId(target.machine)?.name ?? ""))} and keeps its other machines.`,
      confirm: "Revoke",
      run: () => revoke.mutate(targets),
    });
  return (
    <>
      <SettingSection
        label="Devices"
        anchor="fleet-devices"
        note="Phones, tablets and browsers that follow and steer agents. They run none themselves."
        actions={<PairDevice />}
      >
        {loading && fleet.joined.length === 0 && (
          <ListSkeleton label="paired devices" shape="row" rows={2} />
        )}
        {!loading && fleet.joined.length === 0 && <SettingNote>No paired devices.</SettingNote>}
        {failed.length > 0 && (
          <SettingNote role="alert">Couldn't read the devices on {listNames(failed)}.</SettingNote>
        )}
        {fleet.joined.map((device) => {
          const expiry = expiryLine(device.expiresAt, now);
          return (
            <SettingRow
              key={device.key}
              title={device.name}
              description={[
                device.self ? "This device" : undefined,
                machinesLine(device, fleet),
                accessLine(device),
                expiry,
              ]
                .filter(Boolean)
                .join(" · ")}
              inline
            >
              <span className="text-xs text-subtle-foreground tabular-nums">
                Seen {formatAgo(device.lastSeenAt, now)}
              </span>
              <RowMenu label={`Actions for ${device.name}`}>
                <MenuItem danger onClick={() => confirmRevoke(device, device.on)}>
                  Revoke
                </MenuItem>
                {device.on.length > 1 &&
                  device.on.map((target) => (
                    <MenuItem key={target.machine} onClick={() => confirmRevoke(device, [target])}>
                      Revoke on {fleet.byId(target.machine)?.name}
                    </MenuItem>
                  ))}
              </RowMenu>
            </SettingRow>
          );
        })}
      </SettingSection>
      <OpenLinks fleet={fleet} now={now} />
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}

/** Pairing links made but not used yet, on any machine: what each grants and when it lapses. */
function OpenLinks(props: { fleet: Fleet; now: number }) {
  const { fleet, now } = props;
  const toast = useToast();
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
  if (open.length === 0) return null;
  return (
    <SettingSection
      label="Open pairing links"
      anchor="fleet-links"
      note="Each works once. Cancel one you shared by mistake."
    >
      {open.map(({ machine, pairing }) => {
        const keeps = deviceLifetimes.find((entry) => entry.value === (pairing.deviceTtlMs ?? 0));
        return (
          <SettingRow
            key={`${machine.id}:${pairing.id}`}
            title={pairing.label ?? "Pairing link"}
            description={[
              machine.name,
              deviceScopeLabels(pairing.scopes),
              pairing.deviceTtlMs ? `access for ${keeps?.label ?? "a while"}` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
            inline
          >
            <span className="text-xs text-subtle-foreground tabular-nums">
              Expires in {formatCountdown(pairing.expiresAt - now)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ machine, pairing })}
            >
              Cancel
            </Button>
          </SettingRow>
        );
      })}
    </SettingSection>
  );
}
