import type { Device } from "@ace/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import type { Machine } from "./data/backend.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";
import { PairDevice } from "./pair-device.tsx";

const platformNames: Record<Machine["platform"], string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function lastSeen(at: number, now: number): string {
  const age = formatAge(at, now);
  return age === "now" ? "last seen just now" : `last seen ${age} ago`;
}

/** Machines running the daemon, paired phones and browsers, pairing and revoking. */
export function RemoteDevices() {
  return (
    <>
      <Machines />
      <PairedDevices />
    </>
  );
}

function Machines() {
  const backend = useSettingsBackend();
  const machines = useQuery(settingsQueries.machines(backend));
  const now = useNow();
  return (
    <SettingSection label="Machines">
      {machines.isPending && <Spinner aria-label="Loading machines" />}
      {machines.isError && <LoadError error={machines.error} />}
      {machines.data?.map((machine) => (
        <SettingRow
          key={machine.id}
          title={machine.name}
          description={[
            machine.current ? "This machine" : platformNames[machine.platform],
            `${machine.threads} thread${machine.threads === 1 ? "" : "s"}`,
            `daemon ${machine.daemonVersion}`,
            ...(machine.current ? [] : [lastSeen(machine.lastSeenAt, now)]),
          ].join(" · ")}
        >
          <Dot tone={machine.online ? "done" : "idle"} />
          <span className="text-sm text-muted-foreground">
            {machine.online ? "Online" : "Offline"}
          </span>
        </SettingRow>
      ))}
    </SettingSection>
  );
}

function LoadError(props: { error: Error }) {
  return (
    <p role="alert" className="border-t py-3.5 text-sm text-muted-foreground">
      {props.error.message}
    </p>
  );
}

function PairedDevices() {
  const backend = useSettingsBackend();
  const devices = useQuery(settingsQueries.devices(backend));
  const now = useNow();
  const [revoking, setRevoking] = useState<Device | undefined>();
  return (
    <SettingSection label="Paired devices">
      {devices.isPending && <Spinner aria-label="Loading paired devices" />}
      {devices.isError && <LoadError error={devices.error} />}
      {devices.data?.length === 0 && (
        <p className="border-t py-3.5 text-sm text-muted-foreground">
          No phones or browsers are paired with this daemon.
        </p>
      )}
      {devices.data?.map((device) => (
        <SettingRow
          key={device.id}
          title={device.name}
          description={[
            device.scopes.includes("operate") ? "Can view and act" : "View only",
            `paired ${formatAge(device.createdAt, now)} ago`,
            lastSeen(device.lastSeenAt, now),
          ].join(" · ")}
        >
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Revoke ${device.name}`}
            onClick={() => setRevoking(device)}
          >
            Revoke
          </Button>
        </SettingRow>
      ))}
      <SettingRow
        title="Pair a device"
        description="Scan a code with the ace app on your phone, or open the link on another computer."
      >
        <PairDevice />
      </SettingRow>
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
      toast.add({ title: `${device.name} can no longer reach this daemon` });
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
