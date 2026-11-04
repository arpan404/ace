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
import { agentAccessNotes, agentAccessOptions } from "@ace/ui-core";
import { RemoteNetworkRows } from "./remote-networks.tsx";

export { agentAccessNotes, agentAccessOptions };

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
        <div className="mb-6">
          <h3 className="text-md font-medium">Shared settings</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Changes below apply to {names || "this machine"}. Offline machines keep their settings.
            Open a machine above to change only its settings.
          </p>
        </div>
        <AccessRows
          remote={props.fleet.machines.filter((machine) => !machine.primary && machine.client)}
        />
        <FleetMachineAccess fleet={props.fleet} />
      </section>
    </AllMachinesScope>
  );
}

/** Remote access, its networks and agents from other machines, for the machine(s) in scope. */
export function AccessRows(props: { remote: readonly Machine[] }) {
  const id = useId();
  const [risky, setRisky] = useState<Confirming>();
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
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
  return (
    <>
      <SettingSection card label="Remote connections" anchor="fleet-access">
        <SettingRow
          id="remote.enabled"
          title="Remote access"
          description="Allow paired phones, browsers and linked machines to connect. Turning this off disconnects them."
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
      </SettingSection>
      <RemoteNetworkRows remote={props.remote} enabled={enabled.value} />
      <SettingSection
        card
        label="Agent access"
        anchor="agent-access"
        note="The maximum access allowed for agents from linked machines. Individual machine permissions can restrict it further."
      >
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
      </SettingSection>
      <SettingSection card label="Moving work between machines" anchor="work-transfers">
        <SettingRow
          id="remote.agentTransfers"
          title="Agents can move projects and threads to other machines"
          description="Allow agents to transfer work to another machine so it can continue there."
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
      <SettingSection card label="Pairing links" anchor="pairing-links">
        <SettingRow
          id="remote.hostedPairingLink"
          title="Pairing links open app.acehq.dev"
          description="On, pairing links open the hosted web client. Off, they open the web client served by the machine being paired."
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
      </SettingSection>
      <ConfirmDialog confirming={risky} onDone={() => setRisky(undefined)} />
    </>
  );
}
