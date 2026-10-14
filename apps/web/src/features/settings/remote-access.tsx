import { useRemoteStatus } from "./data/use-settings.ts";
import { useId } from "react";
import { SettingCard, SettingNote, SettingRow } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useSettingControl } from "./data/use-settings.ts";
import { settingKeys } from "./data/setting-keys.ts";
import { DaemonSlot } from "./setting-control.tsx";

export function RemoteAccess() {
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
    <SettingCard className="mt-7">
      <SettingRow
        id="remote.enabled"
        title="Remote access"
        description="Only paired devices can connect."
        htmlFor={id}
        inline
        compact
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
        <SettingNote>
          Remote access is controlled by this computer's launch configuration. Change it there to
          use these controls.
        </SettingNote>
      )}
      {status.data?.error && (
        <SettingNote role="alert" className="text-destructive">
          {status.data.error} Retrying automatically.
        </SettingNote>
      )}
      {status.isError && <SettingNote role="alert">{status.error.message}</SettingNote>}
      <SettingRow
        id="remote.transport"
        title="Transport"
        description={selected === "lan" ? "Trust this computer’s HTTPS certificate." : undefined}
        inline
        compact
      >
        <DaemonSlot control={transport}>
          <Select
            label="Transport"
            value={selected}
            options={[
              { value: "lan", label: "LAN" },
              { value: "tailscale", label: "Tailscale" },
              { value: "relay", label: "Relay" },
            ]}
            disabled={transport.offline || transport.pending || overridden || !status.data}
            onValueChange={transport.set}
          />
        </DaemonSlot>
      </SettingRow>
      <SettingNote>
        {selected === "lan"
          ? "Encrypted access on your local network. Browsers must trust this computer's HTTPS certificate. Never forward its local port to the internet."
          : selected === "tailscale"
            ? "Encrypted access on your private Tailscale network. Tailscale must be running; ace never falls back to LAN."
            : "Use a relay you host yourself for encrypted files, delegation, browser and computer controls. Direct LAN access stays on for pairing and conversations."}
      </SettingNote>
      <SettingRow
        id="remote.agentAccess"
        title="Agents on other devices can use this machine"
        htmlFor={`${id}-agents`}
        inline
        compact
      >
        <DaemonSlot control={agents}>
          <Switch
            id={`${id}-agents`}
            checked={agents.value !== "off"}
            disabled={agents.offline || agents.pending}
            onCheckedChange={(on) => agents.set(on ? "read" : "off")}
          />
        </DaemonSlot>
      </SettingRow>
      {agents.value !== "off" && (
        <SettingRow title="Scope" inline compact>
          <Select
            label="Scope"
            value={agents.value}
            options={[
              { value: "read", label: "Read only" },
              { value: "operate", label: "Read and act" },
            ]}
            disabled={agents.offline || agents.pending}
            onValueChange={agents.set}
          />
        </SettingRow>
      )}
      {selected === "relay" && (
        <SettingRow title="Relay address" htmlFor={`${id}-relay`} compact>
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
    </SettingCard>
  );
}
