import { CaretLeftIcon } from "@phosphor-icons/react";
import { formatAgo, formatCountdown } from "@ace/ui-core";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MachineLabel, MachineMark } from "@/components/ui/machine-label.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { RowMenu } from "@/components/ui/row-menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useMachinePool } from "@/lib/machine-pool.ts";
import { machineProblem, machineStatus } from "@/lib/machine-status.ts";
import { primaryMachineId, type Machine } from "@/lib/machines.ts";
import { useNow } from "@/lib/time.ts";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { fleetProblem, revokeDevice } from "./data/fleet.ts";
import { linkDeviceIds, reach, type Reach } from "./data/fleet-links.ts";
import { useFleet, type Fleet } from "./data/use-fleet.ts";
import { deviceScopeLabels } from "./device-scopes.ts";
import { AccessRows } from "./fleet-rules.tsx";
import { MachineEditor } from "./machine-editor.tsx";
import { MachineScope } from "./machine-scope.tsx";
import { PairDevice } from "./pair-device.tsx";
import { SettingsBody } from "./settings-body.tsx";

const back = (
  <Link
    to="/settings/remote"
    aria-label="Back to Fleet"
    className="inline-flex items-center gap-1 rounded-xs text-muted-foreground focus-ring hover:text-foreground"
  >
    <CaretLeftIcon aria-hidden size={12} />
    Fleet
  </Link>
);

/** One direction of a link, in a word or two. */
export function reachLabel(value: Reach): string {
  switch (value.kind) {
    case "linked":
      return value.access === "operate" ? "Read and act" : "Read only";
    case "closed":
      return "Agents off there";
    case "unreachable":
      return "Couldn't reach";
    case "missing":
      return "Not linked";
    case "unknown":
      return "Unknown";
  }
}

/**
 * One machine in the fleet: its name and how it opens up, which machines it uses and which use
 * it, the devices paired to it, and removing it from the fleet.
 */
export function FleetMachinePage(props: { id: string }) {
  const fleet = useFleet();
  // This window's own machine is addressed as "primary", so its page survives its host id loading.
  const machine =
    props.id === primaryMachineId
      ? fleet.machines.find((entry) => entry.primary)
      : fleet.byId(props.id);
  if (!machine)
    return (
      <SettingsBody page="Machine not found" back={back}>
        <p role="alert" className="mt-4 text-muted-foreground">
          This machine isn't in the fleet any more.
        </p>
      </SettingsBody>
    );
  const status =
    machine.status === "online"
      ? machine.primary
        ? "This machine"
        : "Connected"
      : machine.status === "auth_failed" || machine.failed
        ? machineProblem(machine.status, !!machine.failed)
        : machineStatus[machine.status].label;
  return (
    <SettingsBody
      page={machine.name}
      back={back}
      icon={<MachineMark icon={machine.icon} primary={machine.primary} />}
      lede={status}
      titleActions={!machine.primary && <Reconnect machine={machine} />}
    >
      <Identity machine={machine} />
      <Links machine={machine} fleet={fleet} />
      <MachineDevices machine={machine} fleet={fleet} />
      {!machine.primary && <RemoveMachine machine={machine} fleet={fleet} />}
    </SettingsBody>
  );
}

/** Try an offline machine again now instead of waiting for the next automatic attempt. */
function Reconnect(props: { machine: Machine }) {
  const pool = useMachinePool();
  if (props.machine.status === "online" || props.machine.status === "connecting") return null;
  return (
    <Button size="sm" variant="ghost" onClick={() => pool?.reconnect(props.machine.id)}>
      Reconnect
    </Button>
  );
}

function Identity(props: { machine: Machine }) {
  const { machine } = props;
  const pool = useMachinePool();
  const [editing, setEditing] = useState(false);
  return (
    <SettingSection label="Machine" anchor="machine">
      <SettingRow id="host.displayName" title="Name and icon" inline>
        <MachineLabel name={machine.name} icon={machine.icon} primary={machine.primary} />
        <Button
          size="sm"
          variant="ghost"
          disabled={!machine.client}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
      </SettingRow>
      {machine.client ? (
        <MachineScope machine={machine}>
          <AccessRows remote={machine.primary ? [] : [machine]} />
        </MachineScope>
      ) : (
        <SettingNote>Its access settings show when it's back online.</SettingNote>
      )}
      {editing && (
        <MachineEditor
          machine={machine}
          onClose={() => setEditing(false)}
          onSaved={async (name, icon) => {
            if (!machine.primary) await pool?.rename(machine.id, name, icon);
          }}
        />
      )}
    </SettingSection>
  );
}

/** Which machines this one's agents use, and which use it, each direction linkable on its own. */
function Links(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>();
  const self = fleet.facts.find((entry) => entry.id === machine.id);
  const others = fleet.facts.filter((entry) => entry.id !== machine.id);
  const linksError = fleet.links.get(machine.id)?.error;
  if (!self) return null;
  return (
    <SettingSection
      label="Links"
      anchor="links"
      note={
        others.length
          ? `Which machines ${machine.name}'s agents can use, and which can use ${machine.name}.`
          : undefined
      }
    >
      {others.length === 0 && (
        <SettingNote>Add another machine to link it with this one.</SettingNote>
      )}
      {linksError && <SettingNote role="alert">{fleetProblem(linksError)}</SettingNote>}
      {others.length > 0 && (
        <table className="w-full text-ui">
          <thead>
            <tr className="text-left text-xs text-subtle-foreground">
              <th className="py-2 font-normal">
                <span className="sr-only">Machine</span>
              </th>
              <th className="py-2 font-normal">{machine.name} uses it</th>
              <th className="py-2 font-normal">It uses {machine.name}</th>
              <th className="w-8">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-soft">
            {others.map((other) => {
              const out = reach(self, other);
              const inbound = reach(other, self);
              const peer = fleet.byId(other.id);
              const gaps = fleet.gaps.filter(
                (gap) =>
                  (gap.from === self.id && gap.to === other.id) ||
                  (gap.from === other.id && gap.to === self.id),
              );
              const linked = out.kind !== "missing" || inbound.kind !== "missing";
              return (
                <tr key={other.id} className="group/setting h-(--setting-row-height)">
                  <td className="pr-3 text-md text-foreground">{other.name}</td>
                  <td
                    className={
                      out.kind === "missing" ? "text-subtle-foreground" : "text-muted-foreground"
                    }
                  >
                    {reachLabel(out)}
                  </td>
                  <td
                    className={
                      inbound.kind === "missing"
                        ? "text-subtle-foreground"
                        : "text-muted-foreground"
                    }
                  >
                    {reachLabel(inbound)}
                  </td>
                  <td className="text-right">
                    {gaps.length > 0 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="-mr-2.5"
                        disabled={fleet.link.isPending}
                        onClick={() =>
                          fleet.link.mutate(gaps, {
                            onError: (error) =>
                              toast.error({ title: "Couldn't link", description: error.message }),
                          })
                        }
                      >
                        Link
                      </Button>
                    ) : (
                      linked &&
                      peer && (
                        <RowMenu label={`Actions for ${other.name}`}>
                          <MenuItem
                            danger
                            onClick={() =>
                              setConfirming({
                                title: `Unlink ${machine.name} and ${other.name}?`,
                                body: "Agents on either machine stop using the other. Link them again any time.",
                                confirm: "Unlink",
                                run: () =>
                                  fleet.unlink.mutate(
                                    { machine, others: [peer] },
                                    {
                                      onError: (error) =>
                                        toast.error({
                                          title: "Couldn't unlink",
                                          description: error.message,
                                        }),
                                    },
                                  ),
                              })
                            }
                          >
                            Unlink
                          </MenuItem>
                        </RowMenu>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </SettingSection>
  );
}

/** The phones, tablets and browsers paired to this machine, each revocable. */
function MachineDevices(props: { machine: Machine; fleet: Fleet }) {
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
    onError: (error) => toast.error({ title: "Couldn't revoke", description: error.message }),
  });
  return (
    <SettingSection
      label="Devices"
      anchor="devices"
      actions={machine.client ? <PairDevice machine={machine.id} /> : undefined}
    >
      {!machine.client && <SettingNote>Its devices show when it's back online.</SettingNote>}
      {query?.isError && <SettingNote role="alert">{fleetProblem(query.error)}</SettingNote>}
      {machine.client && query?.isSuccess && devices.length === 0 && (
        <SettingNote>No paired devices.</SettingNote>
      )}
      {devices.map((device) => {
        const expires = device.expiresAt ?? null;
        return (
          <SettingRow
            key={device.id}
            title={device.name}
            description={[
              deviceScopeLabels(device.scopes),
              expires === null
                ? undefined
                : expires <= now
                  ? "Expired"
                  : `Expires in ${formatCountdown(expires - now)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
            inline
          >
            <span className="text-xs text-subtle-foreground tabular-nums">
              Seen {formatAgo(device.lastSeenAt, now)}
            </span>
            <RowMenu label={`Actions for ${device.name}`}>
              <MenuItem
                danger
                onClick={() =>
                  setConfirming({
                    title: `Revoke ${device.name}?`,
                    body: `It disconnects from ${machine.name} at once and has to be paired again.`,
                    confirm: "Revoke",
                    run: () => revoke.mutate(device.id),
                  })
                }
              >
                Revoke
              </MenuItem>
            </RowMenu>
          </SettingRow>
        );
      })}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </SettingSection>
  );
}

/**
 * Take a machine out of the fleet: unlink it from every machine both ways, then forget it here.
 * Its threads stay on it; it can be added again with a fresh pairing link.
 */
function RemoveMachine(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const pool = useMachinePool();
  const toast = useToast();
  const navigate = useNavigate();
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
      void navigate({ to: "/settings/remote" });
    },
    onError: (error) => toast.error({ title: "Couldn't remove it", description: error.message }),
  });
  return (
    <SettingSection label="Remove" anchor="remove">
      <SettingRow
        title="Remove from fleet"
        description="Unlinks it from every machine and disconnects it here. Its threads stay on it."
        inline
      >
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={remove.isPending}
          onClick={() =>
            setConfirming({
              title: `Remove ${machine.name} from the fleet?`,
              body: "Agents stop using it and it stops using the others. Add it again with a fresh pairing link.",
              confirm: "Remove",
              run: () => remove.mutate(),
            })
          }
        >
          Remove
        </Button>
      </SettingRow>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </SettingSection>
  );
}
