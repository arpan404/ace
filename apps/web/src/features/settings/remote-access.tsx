import { useRemoteStatus } from "./data/use-settings.ts";
import { useId } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
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
    <div className="mt-7">
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
        <p className="py-2 text-sm text-muted-foreground">
          Remote access is controlled by this computer's launch configuration. Change it there to
          use these controls.
        </p>
      )}
      {status.isError && (
        <p role="alert" className="py-2 text-sm text-muted-foreground">
          {status.error.message}
        </p>
      )}
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
    </div>
  );
}
