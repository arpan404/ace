import { useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import type { Machine } from "@/lib/machines.ts";
import { AllMachinesScope } from "./all-machines-scope.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { listNames } from "./data/list-names.ts";

export const transportOptions = [
  { value: "lan", label: "Local network" },
  { value: "tailscale", label: "Tailscale" },
  { value: "relay", label: "Relay" },
] as const;

export const transportNotes: Record<(typeof transportOptions)[number]["value"], string> = {
  lan: "Same network only. Browsers must trust its HTTPS certificate.",
  tailscale:
    "Your private Tailscale network, from anywhere. For browsers, turn on HTTPS certificates in Tailscale.",
  relay: "Through a relay you host. The local network stays on for pairing.",
};

export const agentAccessOptions = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "operate", label: "Read and act" },
] as const;

export const agentAccessNotes: Record<(typeof agentAccessOptions)[number]["value"], string> = {
  off: "Agents on other machines can't use this one.",
  read: "They can check status and read pages here, never start work.",
  operate: "They can start threads here, answer and use its browser.",
};

/**
 * How the fleet's machines open up, set on every connected machine at once: remote access, the
 * network they're reached over and whether other machines' agents may come in. A row whose
 * machines disagree says "Differs"; a machine's own page can still set it apart.
 */
export function FleetRules(props: { machines: readonly Machine[] }) {
  const several = props.machines.filter((machine) => machine.client).length > 1;
  return (
    <AllMachinesScope machines={props.machines}>
      <SettingSection
        label="Access"
        anchor="fleet-access"
        note={
          several
            ? "Set on every connected machine. A machine's own page can set it apart."
            : undefined
        }
      >
        <AccessRows
          remote={props.machines.filter((machine) => !machine.primary && machine.client)}
        />
      </SettingSection>
    </AllMachinesScope>
  );
}

/** Remote access, its network and agents from other machines, for the machine(s) in scope. */
export function AccessRows(props: { remote: readonly Machine[] }) {
  const id = useId();
  const [risky, setRisky] = useState<Confirming>();
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const transport = useSettingControl(settingKeys.remoteTransport, "Reached over");
  const relay = useSettingControl(settingKeys.relayUrl, "Relay address");
  const hosted = useSettingControl(
    settingKeys.hostedPairingLink,
    "Pairing links open app.acehq.dev",
  );
  const agents = useSettingControl(settingKeys.agentAccess, "Agents from other machines");
  const transfers = useSettingControl(
    settingKeys.agentTransfers,
    "Agents can move projects and threads to other machines",
  );
  const ignored = useSettingControl(settingKeys.transferIgnoredFiles, "Bring ignored files");
  // "local" is remote access off; the choice shows the network it would open on.
  const selected = transport.value === "local" ? "lan" : transport.value;
  return (
    <>
      <SettingRow
        id="remote.enabled"
        title="Remote access"
        description="Paired devices and linked machines can connect. Needed to pair and to link."
        htmlFor={id}
        inline
      >
        <DaemonSlot control={enabled}>
          <Switch
            id={id}
            checked={enabled.value}
            disabled={enabled.offline || enabled.pending}
            onCheckedChange={(on) => {
              if (on || !props.remote.length) return void enabled.set(on);
              setRisky({
                title: "Turn off remote access everywhere?",
                body: `This window reaches ${listNames(props.remote.map((machine) => machine.name))} through remote access. Turning it off disconnects them here, and their paired devices too, until it's turned on again on each machine.`,
                confirm: "Turn off",
                run: () => void enabled.set(false),
              });
            }}
          />
        </DaemonSlot>
      </SettingRow>
      <SettingRow id="remote.transport" title="Reached over" description={transportNotes[selected]}>
        <DaemonSlot control={transport}>
          <Select
            label="Reached over"
            value={selected}
            options={transportOptions}
            disabled={transport.offline || transport.pending || !enabled.value}
            onValueChange={(next) => {
              if (!props.remote.length) return void transport.set(next);
              setRisky({
                title: `Reach every machine over ${transportOptions.find((option) => option.value === next)?.label ?? next}?`,
                body: `${listNames(props.remote.map((machine) => machine.name))} may disconnect from this window until it can reach them on the new network.`,
                confirm: "Change",
                run: () => void transport.set(next),
              });
            }}
          />
        </DaemonSlot>
      </SettingRow>
      {selected === "relay" && (
        <SettingRow title="Relay address" htmlFor={`${id}-relay`}>
          <DaemonSlot control={relay}>
            <Input
              id={`${id}-relay`}
              aria-label="Relay address"
              key={relay.value}
              defaultValue={relay.value}
              placeholder="wss://relay.example.com/"
              disabled={relay.offline || relay.pending}
              onBlur={(event) => {
                if (event.target.value !== relay.value) relay.set(event.target.value.trim());
              }}
            />
          </DaemonSlot>
        </SettingRow>
      )}
      <SettingRow
        id="remote.hostedPairingLink"
        title="Pairing links open app.acehq.dev"
        description="Off, links open the web app this computer serves, which always matches its version."
        htmlFor={`${id}-hosted`}
        inline
      >
        <DaemonSlot control={hosted}>
          <Switch
            id={`${id}-hosted`}
            checked={hosted.value}
            disabled={hosted.offline || hosted.pending}
            onCheckedChange={(on) => void hosted.set(on)}
          />
        </DaemonSlot>
      </SettingRow>
      <SettingRow
        id="remote.agentAccess"
        title="Agents from other machines"
        description={agentAccessNotes[agents.value]}
      >
        <DaemonSlot control={agents}>
          <SegmentedControl
            label="Agents from other machines"
            value={agents.value}
            options={agentAccessOptions}
            disabled={agents.offline || agents.pending}
            onValueChange={agents.set}
          />
        </DaemonSlot>
      </SettingRow>
      <SettingRow
        id="remote.agentTransfers"
        title="Agents can move projects and threads to other machines"
        htmlFor={`${id}-transfers`}
        inline
      >
        <DaemonSlot control={transfers}>
          <Switch
            id={`${id}-transfers`}
            checked={transfers.value}
            disabled={transfers.offline || transfers.pending}
            onCheckedChange={(on) => void transfers.set(on)}
          />
        </DaemonSlot>
      </SettingRow>
      <SettingRow
        id="remote.transferIgnoredFiles"
        title="Bring ignored files"
        description="Local files Git ignores, such as .env and local config, go too. Dependency folders are rebuilt there instead."
        htmlFor={`${id}-ignored`}
        inline
      >
        <DaemonSlot control={ignored}>
          <Switch
            id={`${id}-ignored`}
            checked={ignored.value}
            disabled={ignored.offline || ignored.pending}
            onCheckedChange={(on) => void ignored.set(on)}
          />
        </DaemonSlot>
      </SettingRow>
      <ConfirmDialog confirming={risky} onDone={() => setRisky(undefined)} />
    </>
  );
}
