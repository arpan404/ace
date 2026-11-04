import { agentAccessNotes, agentAccessOptions } from "@ace/ui-core";
import { HairlineRow, RowAction, RowGroup } from "@/components/hairline-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { AllMachinesScope } from "./all-machines-scope.tsx";
import { transferLine } from "./data/fleet-words.ts";
import { settingKeys } from "./data/setting-keys.ts";
import type { Fleet } from "./data/use-fleet.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { GrantRow } from "./permissions-sheet.tsx";
import { DaemonSlot } from "./setting-control.tsx";

/**
 * How the machines work together, set on every connected machine at once: how far other
 * machines' agents may go, what they may use, and whether agents move threads between
 * machines. A value the machines disagree on says so; a machine's own page sets it apart.
 */
export function WorkingAcrossMachines(props: { fleet: Fleet }) {
  const hosts = props.fleet.machines.filter((machine) => machine.client);
  return (
    <AllMachinesScope machines={props.fleet.machines}>
      <RowGroup
        label="Working across machines"
        anchor="fleet-access"
        note="Set on every connected machine. Open a machine to set it there alone."
      >
        <AgentAccessRow />
        <GrantRow
          id="fleet.grants"
          fleet={props.fleet}
          title="What they may use"
          scope={{
            hosts,
            peer: "all",
            title: "What other machines' agents may use",
            sub: "On every connected machine, for each machine linked to it. A machine's own page sets it for that machine alone.",
          }}
        />
        <TransfersRow />
      </RowGroup>
    </AllMachinesScope>
  );
}

/** How far agents on other machines may go here: Off, Read, or Read and act. */
export function AgentAccessRow() {
  const agents = useSettingControl(settingKeys.agentAccess, "Agents from other machines");
  return (
    <HairlineRow
      id="remote.agentAccess"
      wide
      title="Other machines' agents"
      sub={agentAccessNotes[agents.value]}
      actions={
        <DaemonSlot control={agents}>
          <SegmentedControl
            size="sm"
            label="Agents from other machines"
            value={agents.value}
            options={agentAccessOptions}
            disabled={agents.offline || agents.pending}
            onValueChange={agents.set}
          />
        </DaemonSlot>
      }
    />
  );
}

/** Whether agents move threads to other machines, and whether ignored files go too. */
export function TransfersRow() {
  const transfers = useSettingControl(
    settingKeys.agentTransfers,
    "Agents can move projects and threads to other machines",
  );
  const ignored = useSettingControl(settingKeys.transferIgnoredFiles, "Bring ignored files");
  const busy = transfers.offline || transfers.pending || ignored.pending;
  return (
    <HairlineRow
      id="remote.agentTransfers"
      title="Move threads between machines"
      sub={transferLine({
        on: transfers.value,
        ignored: ignored.value,
        differs: !!(transfers.differs || ignored.differs),
      })}
      actions={
        <DaemonSlot control={{ ...transfers, differs: false }}>
          {transfers.value && (
            <RowAction reveal disabled={busy} onClick={() => void ignored.set(!ignored.value)}>
              {ignored.value ? "Leave ignored files" : "Bring ignored files"}
            </RowAction>
          )}
          <RowAction
            reveal={transfers.value}
            className={transfers.value ? undefined : "text-foreground"}
            aria-label={`${transfers.value ? "Turn off" : "Turn on"} moving threads between machines`}
            disabled={busy}
            onClick={() => void transfers.set(!transfers.value)}
          >
            {transfers.value ? "Turn off" : "Turn on"}
          </RowAction>
        </DaemonSlot>
      }
    />
  );
}
