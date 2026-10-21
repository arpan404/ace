import { useId } from "react";
import { SettingNote, SettingRow } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { useRemoteStatus, useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";

const transports = [
  { value: "lan", label: "LAN" },
  { value: "tailscale", label: "Tailscale" },
  { value: "relay", label: "Relay" },
] as const;

/** What each transport means for the devices that connect, in one line. */
const transportNotes: Record<(typeof transports)[number]["value"], string> = {
  lan: "Local network only. Browsers must trust its HTTPS certificate.",
  tailscale: "Your private Tailscale network. Tailscale must be running.",
  relay: "Through a relay you host. LAN stays on for pairing.",
};

const agentAccess = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "operate", label: "Read and act" },
] as const;

/**
 * How other devices reach this window's own daemon: remote access, its transport, a relay
 * address, and whether agents on other machines may use it. Rows for the "This machine" card.
 */
export function RemoteAccessRows() {
  const id = useId();
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const transport = useSettingControl(settingKeys.remoteTransport, "Transport");
  const relay = useSettingControl(settingKeys.relayUrl, "Relay address");
  const agents = useSettingControl(
    settingKeys.agentAccess,
    "Agents on other devices can use this machine",
  );
  const status = useRemoteStatus();
  const overridden =
    (status.data?.listenOverride !== null && status.data?.listenOverride !== undefined) ||
    status.data?.relayOverride === true;
  const selected =
    overridden && status.data?.transport !== "local"
      ? (status.data?.transport ?? "lan")
      : transport.value === "local"
        ? "lan"
        : transport.value;
  return (
    <>
      <SettingRow
        id="remote.enabled"
        title="Remote access"
        description="Only paired devices can connect."
        htmlFor={id}
        inline
      >
        <DaemonSlot control={enabled}>
          <Switch
            id={id}
            checked={overridden ? (status.data?.enabled ?? enabled.value) : enabled.value}
            disabled={enabled.offline || enabled.pending || overridden || !status.data}
            onCheckedChange={enabled.set}
          />
        </DaemonSlot>
      </SettingRow>
      {overridden && (
        <SettingNote>Set by this computer's launch configuration. Change it there.</SettingNote>
      )}
      {status.data?.error && (
        <SettingNote role="alert" className="text-destructive">
          {status.data.error} Retrying automatically.
        </SettingNote>
      )}
      {status.isError && <SettingNote role="alert">{status.error.message}</SettingNote>}
      <SettingRow id="remote.transport" title="Transport" description={transportNotes[selected]}>
        <DaemonSlot control={transport}>
          <Select
            label="Transport"
            value={selected}
            options={transports}
            disabled={transport.offline || transport.pending || overridden || !status.data}
            onValueChange={transport.set}
          />
        </DaemonSlot>
      </SettingRow>
      {selected === "relay" && (
        <SettingRow title="Relay address" htmlFor={`${id}-relay`}>
          <Input
            id={`${id}-relay`}
            aria-label="Relay address"
            key={relay.value}
            defaultValue={relay.value}
            placeholder="wss://relay.example.com/"
            disabled={relay.offline || relay.pending || overridden}
            onBlur={(event) => {
              if (event.target.value !== relay.value) relay.set(event.target.value.trim());
            }}
          />
        </SettingRow>
      )}
      <SettingRow
        id="remote.agentAccess"
        title="Agents on other devices can use this machine"
        description={
          agents.value === "operate"
            ? "They can start work here, answer and use its browser."
            : agents.value === "read"
              ? "They can check status and read pages, never start work."
              : undefined
        }
      >
        <DaemonSlot control={agents}>
          <SegmentedControl
            label="Agents on other devices can use this machine"
            value={agents.value}
            options={agentAccess}
            disabled={agents.offline || agents.pending}
            onValueChange={agents.set}
          />
        </DaemonSlot>
      </SettingRow>
    </>
  );
}
