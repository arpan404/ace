import { useId, useState } from "react";
import type { RemoteNetworks, RemoteNetworkStatus } from "@ace/protocol";
import {
  accountReachNote,
  remoteNetworkNotes,
  remoteNetworks,
  type RemoteNetworkKey,
} from "@ace/ui-core";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import type { Machine } from "@/lib/machines.ts";
import { settingKeys } from "./data/setting-keys.ts";
import { useRemoteStatus, useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { listNames } from "./data/list-names.ts";

const statusOf: Record<RemoteNetworkKey, keyof RemoteNetworks> = {
  "remote.lan": "lan",
  "remote.tailscale": "tailscale",
  "remote.relay": "relay",
};

/** One sentence for a network: what it's doing now when this machine says, else what it is. */
function networkSentence(
  key: RemoteNetworkKey,
  on: boolean,
  live: RemoteNetworkStatus | undefined,
  hosted: string | undefined,
): string {
  if (live?.error) return live.error;
  if (live?.state === "on" && live.address) {
    if (key !== "remote.relay") return `On at ${live.address}.`;
    return live.address === hosted
      ? "On through ace's relay, from anywhere."
      : `On through ${hostOf(live.address)}, from anywhere.`;
  }
  if (key === "remote.relay" && on) return "Through ace's relay unless you name your own below.";
  return remoteNetworkNotes[key];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The networks remote access serves, all at once (ADR 0112): each a sentence and a text button,
 * the relay's own address when it's on, and how an ace account reaches the machine. Live state
 * shows only when the rows set this window's own machine alone.
 */
export function RemoteNetworkRows(props: { remote: readonly Machine[]; enabled: boolean }) {
  const id = useId();
  const [risky, setRisky] = useState<Confirming>();
  const controls = {
    "remote.lan": useSettingControl(settingKeys.remoteLan, "Local network"),
    "remote.tailscale": useSettingControl(settingKeys.remoteTailscale, "Tailscale"),
    "remote.relay": useSettingControl(settingKeys.remoteRelay, "Relay"),
  };
  const relayUrl = useSettingControl(settingKeys.relayUrl, "Your own relay");
  const status = useRemoteStatus();
  const live = props.remote.length ? undefined : status.data?.networks;
  const hosted =
    live?.account.address ?? (live?.relay.state === "waiting" ? live.relay.address : undefined);
  const account = live?.account;
  return (
    <SettingSection label="Networks" anchor="remote-networks" note={accountReachNote}>
      {remoteNetworks.map((network) => {
        const control = controls[network.key];
        const turn = (on: boolean) => {
          if (on || !props.remote.length) return void control.set(on);
          setRisky({
            title: `Turn off ${network.label} everywhere?`,
            body: `${listNames(props.remote.map((machine) => machine.name))} may disconnect from this window until it can reach them on another network.`,
            confirm: "Turn off",
            run: () => void control.set(false),
          });
        };
        return (
          <SettingRow
            key={network.key}
            id={network.key}
            title={network.label}
            description={networkSentence(
              network.key,
              control.value,
              live?.[statusOf[network.key]],
              hosted,
            )}
            inline
          >
            <DaemonSlot control={control}>
              <Button
                size="sm"
                aria-label={`${control.value ? "Turn off" : "Turn on"} ${network.label}`}
                disabled={control.offline || control.pending || !props.enabled}
                onClick={() => turn(!control.value)}
              >
                {control.value ? "Turn off" : "Turn on"}
              </Button>
            </DaemonSlot>
          </SettingRow>
        );
      })}
      {controls["remote.relay"].value && (
        <SettingRow
          title="Your own relay"
          description="Optional. Leave it empty to use ace's relay."
          htmlFor={`${id}-relay`}
        >
          <DaemonSlot control={relayUrl}>
            <Input
              id={`${id}-relay`}
              aria-label="Your own relay"
              key={relayUrl.value}
              defaultValue={relayUrl.value}
              placeholder="wss://relay.example.com/"
              disabled={relayUrl.offline || relayUrl.pending}
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (next !== relayUrl.value) relayUrl.set(next);
              }}
            />
          </DaemonSlot>
        </SettingRow>
      )}
      {account && account.state !== "off" && (
        <SettingRow
          title="Your ace account"
          description={
            account.error ??
            "This machine is reachable through ace's relay from your account's devices."
          }
        />
      )}
      <ConfirmDialog confirming={risky} onDone={() => setRisky(undefined)} />
    </SettingSection>
  );
}
