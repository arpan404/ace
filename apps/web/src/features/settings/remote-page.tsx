import type { Device } from "@ace/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingRow, SettingSection, SettingSummaryRow } from "@/components/setting-row.tsx";
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
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import type { Machine } from "./data/backend.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";
import { PairDevice } from "./pair-device.tsx";
import { settingRow } from "./settings-index.ts";
import { useHostName } from "@/lib/host-name.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import { UnavailableError } from "@/boot/fake-backend.ts";

const platformNames: Record<Machine["platform"], string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function ago(at: number, now: number): string {
  const age = formatAge(at, now);
  return age === "now" ? "just now" : `${age} ago`;
}

const lastSeen = (at: number, now: number) => `last seen ${ago(at, now)}`;

/** Machines running the daemon, paired phones and browsers, pairing and revoking. */
export function RemoteDevices() {
  return (
    <>
      <Machines />
      <PairedDevices />
    </>
  );
}

/**
 * Machines running the daemon. A daemon that can't list them yet shows the one this window
 * talks to, from the connection, with no error: nothing is wrong.
 */
function Machines() {
  const backend = useSettingsBackend();
  const machines = useQuery(settingsQueries.machines(backend));
  const host = useHostName() ?? "This machine";
  const now = useNow();
  const unlisted = machines.error instanceof UnavailableError;
  return (
    <SettingSection label="Machines" card>
      {machines.isPending && <ListSkeleton label="machines" shape="row" rows={2} />}
      {unlisted && <SettingRow title={host} description="Connected to this machine" />}
      {machines.isError && !unlisted && <LoadError error={machines.error} />}
      {machines.data?.map((machine) => (
        <SettingSummaryRow
          key={machine.id}
          title={machine.current ? host : machine.name}
          description={[
            machine.current ? "This machine" : platformNames[machine.platform],
            `${machine.threads} thread${machine.threads === 1 ? "" : "s"}`,
            `ace ${machine.daemonVersion}`,
            ...(machine.current ? [] : [lastSeen(machine.lastSeenAt, now)]),
          ].join(" · ")}
        >
          <StatusLabel
            tone={machine.online ? "done" : "idle"}
            label={machine.online ? "Online" : "Offline"}
          />
        </SettingSummaryRow>
      ))}
    </SettingSection>
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
  const now = useNow();
  const [revoking, setRevoking] = useState<Device | undefined>();
  return (
    <SettingSection label="Paired devices" card>
      {devices.isPending && <ListSkeleton label="paired devices" shape="row" rows={2} />}
      {devices.isError && <LoadError error={devices.error} />}
      {devices.data?.length === 0 && (
        <p className="py-3.5 text-sm text-muted-foreground">
          No phones or browsers are paired with ace on this machine.
        </p>
      )}
      {devices.data?.map((device) => (
        <SettingSummaryRow
          key={device.id}
          title={device.name}
          description={[
            device.scopes.includes("operate") ? "Can view and act" : "View only",
            `paired ${ago(device.createdAt, now)}`,
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
        </SettingSummaryRow>
      ))}
      <SettingRow
        {...settingRow("remote.pair")}
        description="Scan a code with the ace app on your phone, or open the link on another computer."
        inline
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
      toast.add({ title: `${device.name} can no longer reach ace on this machine` });
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
