import { useState, type ReactNode } from "react";
import type { RemoteNetworks } from "@ace/protocol";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { HairlineRow, RowAction, RowGroup, StateWords } from "@/components/hairline-row.tsx";
import type { Machine } from "@/lib/machines.ts";
import {
  accountReachLine,
  directLine,
  networkOffQuestion,
  remoteOffLine,
  type Dependents,
  type DirectNetwork,
} from "@ace/ui-core/fleet-map";
import { settingKeys } from "./data/setting-keys.ts";
import { useRemoteStatus, useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";

const directRows: readonly { network: DirectNetwork; label: string; id: string }[] = [
  { network: "tailscale", label: "Tailscale", id: "remote.tailscale" },
  { network: "lan", label: "Local network", id: "remote.lan" },
];

/**
 * How a machine is reached (ADR 0112), read and set on that machine (render it inside its
 * `MachineScope`): its ace account, Tailscale and the local network, each a dot, one sentence
 * and one action. `dependents` are what reach it now (devices, other machines): turning a
 * network off asks first while there are any.
 */
export function ReachRows(props: {
  machine: Machine;
  label: string;
  dependents: Dependents;
  /** Rows after the networks: the machine's links with the others. */
  children?: ReactNode;
}) {
  const [risky, setRisky] = useState<Confirming>();
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const status = useRemoteStatus();
  const networks = status.data?.networks;
  const where = props.machine.primary ? "this computer" : props.machine.name;
  return (
    <RowGroup label={props.label} anchor="remote-networks">
      {enabled.loaded && !enabled.value ? (
        <HairlineRow
          sub={<StateWords tone="off">{remoteOffLine(where).words}</StateWords>}
          title="Remote access"
          actions={
            <DaemonSlot control={enabled}>
              <RowAction
                className="text-foreground"
                aria-label="Turn on remote access"
                disabled={enabled.offline || enabled.pending}
                onClick={() => void enabled.set(true)}
              >
                Turn on
              </RowAction>
            </DaemonSlot>
          }
        />
      ) : (
        <>
          <AccountReach machine={props.machine} live={networks?.account} />
          {directRows.map((row) => (
            <DirectReach
              key={row.network}
              {...row}
              live={networks?.[row.network]}
              onRisky={(run) => {
                const question = networkOffQuestion({
                  network: row.label,
                  where,
                  dependents: props.dependents,
                });
                if (question) setRisky({ ...question, run });
                else run();
              }}
            />
          ))}
        </>
      )}
      {props.children}
      <ConfirmDialog confirming={risky} onDone={() => setRisky(undefined)} />
    </RowGroup>
  );
}

function DirectReach(props: {
  network: DirectNetwork;
  label: string;
  id: string;
  live: RemoteNetworks[DirectNetwork] | undefined;
  onRisky(run: () => void): void;
}) {
  const control = useSettingControl(
    props.network === "lan" ? settingKeys.remoteLan : settingKeys.remoteTailscale,
    props.label,
  );
  const line = directLine(props.network, control.value, props.live);
  return (
    <HairlineRow
      id={props.id}
      title={props.label}
      sub={<StateWords tone={line.tone}>{line.words}</StateWords>}
      actions={
        <DaemonSlot control={control}>
          <RowAction
            reveal={control.value}
            className={control.value ? undefined : "text-foreground"}
            aria-label={`${control.value ? "Turn off" : "Turn on"} ${props.label}`}
            disabled={control.offline || control.pending}
            onClick={() =>
              control.value ? props.onRisky(() => void control.set(false)) : void control.set(true)
            }
          >
            {control.value ? "Turn off" : "Turn on"}
          </RowAction>
        </DaemonSlot>
      }
    />
  );
}

/**
 * The ace account row. This computer's own daemon is signed in and out from here; another
 * machine says only whether it's on ace's relay, since it signs in on its own.
 */
/** How this machine is reached through the ace account; Security signs this computer in and out. */
function AccountReach(props: { machine: Machine; live: RemoteNetworks["account"] | undefined }) {
  const line = accountReachLine(props.live, props.machine.primary ? undefined : props.machine.name);
  return (
    <HairlineRow
      id="account.reach"
      title="ace account"
      sub={<StateWords tone={line.tone}>{line.words}</StateWords>}
    />
  );
}
