import { computerCopy } from "@/lib/computer-copy.ts";
import { useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import type { Machine } from "@/lib/machines.ts";
import { FleetMachineAccess } from "./fleet-capabilities.tsx";
import type { Fleet } from "./data/use-fleet.ts";
import { AllMachinesScope } from "./all-machines-scope.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { listNames, summarizeNames } from "./data/list-names.ts";
import { agentAccessNotes as sharedAgentAccessNotes, agentAccessOptions } from "@ace/ui-core";
import { RemoteNetworkRows } from "./remote-networks.tsx";

export { agentAccessOptions };
export const agentAccessNotes = {
  off: computerCopy(sharedAgentAccessNotes.off),
  read: computerCopy(sharedAgentAccessNotes.read),
  operate: computerCopy(sharedAgentAccessNotes.operate),
};

/**
 * How the fleet's machines open up, set on every connected machine at once: remote access, the
 * networks they're reached over and whether other machines' agents may come in. A row whose
 * machines disagree says "Differs"; a machine's own page can still set it apart.
 */
export function FleetRules(props: { fleet: Fleet }) {
  const connected = props.fleet.machines.filter((machine) => machine.client);
  const names = summarizeNames(connected.map((machine) => machine.name));
  return (
    <AllMachinesScope machines={props.fleet.machines}>
      <section aria-label="Access">
        <AccessRows
          note={`Applies to ${names || "this computer"}. Offline computers keep their settings.`}
          remote={props.fleet.machines.filter((machine) => !machine.primary && machine.client)}
        />
        <FleetMachineAccess fleet={props.fleet} />
      </section>
    </AllMachinesScope>
  );
}

/** Remote access, its networks and agents from other machines, for the machine(s) in scope. */
export function AccessRows(props: { remote: readonly Machine[]; note?: string }) {
  const id = useId();
  const [risky, setRisky] = useState<Confirming>();
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const agents = useSettingControl(settingKeys.agentAccess, "Agents from other computers");
  const transfers = useSettingControl(
    settingKeys.agentTransfers,
    "Agents can move projects and threads to other computers",
  );
  const ignored = useSettingControl(settingKeys.transferIgnoredFiles, "Bring ignored files");
  return (
    <>
      <SettingSection label="Networks" anchor="remote-networks" note={props.note}>
        <SettingRow
          id="remote.enabled"
          title="Remote access"
          description="Allow paired phones, browsers and linked computers to connect. Turning this off disconnects them."
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
                  body: `This window reaches ${listNames(props.remote.map((machine) => machine.name))} through remote access. Turning it off disconnects them here, and their paired devices too, until it's turned on again on each computer.`,
                  confirm: "Turn off",
                  run: () => void enabled.set(false),
                });
              }}
            />
          </DaemonSlot>
        </SettingRow>
        <RemoteNetworkRows remote={props.remote} enabled={enabled.value} />
        <HostedPairingRow id={id} />
      </SettingSection>
      <SettingSection card label="Agent access" anchor="agent-access">
        <SettingRow
          id="remote.agentAccess"
          title="Agents from other computers"
          description={agentAccessNotes[agents.value]}
        >
          <DaemonSlot control={agents}>
            <SegmentedControl
              label="Agents from other computers"
              value={agents.value}
              options={agentAccessOptions}
              disabled={agents.offline || agents.pending}
              onValueChange={agents.set}
            />
          </DaemonSlot>
        </SettingRow>
        <SettingRow
          id="remote.agentTransfers"
          title="Agents can move projects and threads to other computers"
          description="Allow agents to transfer work to another computer so it can continue there."
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
      </SettingSection>
      <ConfirmDialog confirming={risky} onDone={() => setRisky(undefined)} />
    </>
  );
}

function HostedPairingRow(props: { id: string }) {
  const hosted = useSettingControl(
    settingKeys.hostedPairingLink,
    "Pairing links open app.acehq.dev",
  );
  return (
    <SettingRow
      id="remote.hostedPairingLink"
      title="Pairing links open app.acehq.dev"
      description="On, pairing links open the hosted web client. Off, they open the web client served by the computer being paired."
      htmlFor={`${props.id}-hosted`}
      inline
    >
      <DaemonSlot control={hosted}>
        <Switch
          id={`${props.id}-hosted`}
          checked={hosted.value}
          disabled={hosted.offline || hosted.pending}
          onCheckedChange={(on) => void hosted.set(on)}
        />
      </DaemonSlot>
    </SettingRow>
  );
}
