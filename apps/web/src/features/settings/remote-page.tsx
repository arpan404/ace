import { formatAgo } from "@ace/ui-core";
import { Machines, ThisMachineRow } from "./machine-editor.tsx";
import { RemoteAccessRows } from "./remote-access.tsx";
import { deviceScopeLabels } from "./device-scopes.ts";
import type { Device } from "@ace/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";
import { PairDevice } from "./pair-device.tsx";
import { RowMenu } from "@/components/ui/row-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useNow } from "@/lib/time.ts";

/**
 * Settings › Machines and devices: this machine (its name, how others reach it and whether
 * their agents may use it), the other machines this window runs agents on, and the phones,
 * tablets and browsers paired to this machine, with pairing and revoking.
 */
export function RemoteDevices() {
  return (
    <>
      <SettingSection label="This machine">
        <ThisMachineRow />
        <RemoteAccessRows />
      </SettingSection>
      <Machines />
      <PairedDevices />
    </>
  );
}

function LoadError(props: { error: Error }) {
  return (
    <p role="alert" className="py-3.5 text-sm text-muted-foreground">
      {props.error.message}
    </p>
  );
}

function PairedDevices() {
  const backend = useSettingsBackend();
  const devices = useQuery(settingsQueries.devices(backend));
  const [revoking, setRevoking] = useState<Device | undefined>();
  const now = useNow();
  return (
    <SettingSection label="Paired devices">
      {devices.isPending && <ListSkeleton label="paired devices" shape="row" rows={2} />}
      {devices.isError && <LoadError error={devices.error} />}
      {devices.data?.length === 0 && <SettingNote>No paired devices.</SettingNote>}
      {devices.data?.map((device) => (
        // In columns: the device, what it may do, when it was last seen, then its menu.
        <SettingRow key={device.id} title={device.name}>
          <span className="text-ui text-muted-foreground @[30rem]:w-32">
            {deviceScopeLabels(device.scopes)}
          </span>
          <span className="text-xs text-subtle-foreground tabular-nums @[30rem]:w-24 @[30rem]:text-right">
            Seen {formatAgo(device.lastSeenAt, now)}
          </span>
          <RowMenu label={`Actions for ${device.name}`}>
            <MenuItem danger onClick={() => setRevoking(device)}>
              Revoke
            </MenuItem>
          </RowMenu>
        </SettingRow>
      ))}
      <PairDevice />
      <RevokeDialog device={revoking} onDone={() => setRevoking(undefined)} />
    </SettingSection>
  );
}

function RevokeDialog(props: { device: Device | undefined; onDone(): void }) {
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const toast = useToast();
  const revoke = useMutation({
    mutationFn: (device: Device) => backend.revoke(device.id),
    onSuccess: async (_, device) => {
      await queryClient.invalidateQueries({ queryKey: settingsQueries.devices(backend).queryKey });
      toast.add({ title: `${device.name} can no longer reach this computer` });
      props.onDone();
    },
  });
  const device = props.device;
  return (
    <Dialog
      open={device !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          revoke.reset();
          props.onDone();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {device?.name}?</DialogTitle>
          <DialogDescription>
            It disconnects at once and has to be paired again to see or control threads.
          </DialogDescription>
        </DialogHeader>
        {revoke.isError && (
          <p role="alert" className="text-sm text-destructive">
            {revoke.error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={props.onDone}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={revoke.isPending}
            onClick={() => device && revoke.mutate(device)}
          >
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
