import { useMachines } from "@/lib/machines.ts";
import { RemoteAccess } from "./remote-access.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { Input } from "@/components/ui/input.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { deviceScopeLabels } from "./device-scopes.ts";
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
      <RemoteAccess />
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
  const listed = useQuery(settingsQueries.machines(backend));
  const connected = useMachines();
  const name = useSettingControl(settingKeys.hostName, "Machine name");
  const now = useNow();
  const unlisted = listed.error instanceof UnavailableError;
  const machines = listed.data;
  return (
    <SettingSection label="Machines">
      <SettingRow id="host.displayName" title="Machine name" htmlFor="host-name" inline compact>
        <Input
          id="host-name"
          key={name.value}
          defaultValue={name.value}
          placeholder={
            machines?.find((machine) => machine.current)?.name ??
            connected[0]?.name ??
            "This machine"
          }
          className="w-52"
          maxLength={256}
          disabled={name.offline}
          onBlur={(event) => {
            if (event.target.value !== name.value) name.set(event.target.value.trim());
          }}
        />
      </SettingRow>
      {listed.isPending && <ListSkeleton label="machines" shape="row" rows={2} />}
      {unlisted &&
        connected.map((machine) => (
          <SettingRow key={machine.id} compact inline title={machine.name}>
            <StatusLabel
              tone={machine.status === "online" ? "done" : "idle"}
              label={machine.status === "online" ? "Online" : "Offline"}
            />
          </SettingRow>
        ))}
      {listed.isError && !unlisted && <LoadError error={listed.error} />}
      {machines?.map((machine) => (
        <SettingRow
          key={machine.id}
          compact
          inline
          title={machine.current && name.value ? name.value : machine.name}
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
        </SettingRow>
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
  const [revoking, setRevoking] = useState<Device | undefined>();
  return (
    <SettingSection label="Paired devices">
      {devices.isPending && <ListSkeleton label="paired devices" shape="row" rows={2} />}
      {devices.isError && <LoadError error={devices.error} />}
      {devices.data?.length === 0 && (
        <p className="py-3.5 text-sm text-muted-foreground">
          No devices are paired with this computer.
        </p>
      )}
      {devices.data?.map((device) => (
        <SettingSummaryRow
          key={device.id}
          compact
          inline
          title={device.name}
          description={[deviceScopeLabels(device.scopes)].join(" · ")}
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
        compact
        {...settingRow("remote.pair")}
        description="Open the link on your other device. Keep it private until it expires."
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
