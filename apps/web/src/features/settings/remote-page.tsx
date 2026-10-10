import { Machines } from "./machine-editor.tsx";
import { RemoteAccess } from "./remote-access.tsx";
import { deviceScopeLabels } from "./device-scopes.ts";
import type { Device } from "@ace/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingSection, SettingSummaryRow } from "@/components/setting-row.tsx";
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

/** Machines running the daemon, paired phones and browsers, pairing and revoking. */
export function RemoteDevices() {
  return (
    <>
      <RemoteAccess />
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
  return (
    <SettingSection label="Paired devices">
      {devices.isPending && <ListSkeleton label="paired devices" shape="row" rows={2} />}
      {devices.isError && <LoadError error={devices.error} />}
      {devices.data?.length === 0 && (
        <p className="py-3.5 text-sm text-muted-foreground">No paired devices.</p>
      )}
      {devices.data?.map((device) => (
        <SettingSummaryRow
          key={device.id}
          title={device.name}
          description={[deviceScopeLabels(device.scopes)].join(" · ")}
        >
          <RowMenu label={`Actions for ${device.name}`}>
            <MenuItem onClick={() => setRevoking(device)}>Revoke</MenuItem>
          </RowMenu>
        </SettingSummaryRow>
      ))}
      <div className="py-1">
        <PairDevice />
      </div>
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
