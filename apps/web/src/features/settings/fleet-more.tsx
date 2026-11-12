import { useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { HairlineList, HairlineRow, RowAction, StateWords } from "@/components/hairline-row.tsx";
import { SettingDisclosure } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { addressWords } from "./data/fleet-words.ts";
import { listNames } from "@ace/ui-core";
import { settingKeys } from "./data/setting-keys.ts";
import { useRemoteStatus, useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";

/** The rows behind More options, for a settings search to open it. */
const inside = new Set(["remote.relay", "remote.enabled", "remote.hostedPairingLink"]);

/**
 * The rarer choices for this computer, folded away: a relay of the person's own, turning remote
 * access off (asking first while devices or machines reach it), and where pairing links open.
 */
export function MoreOptions(props: { dependents: readonly string[] }) {
  const hash = useLocation({ select: (location) => location.hash });
  return (
    <SettingDisclosure title="More options" open={inside.has(hash) || undefined} className="mt-7">
      <HairlineList className="mt-1.5">
        <OwnRelay />
        <RemoteAccessSwitch dependents={props.dependents} />
        <HostedLinks />
      </HairlineList>
    </SettingDisclosure>
  );
}

function OwnRelay() {
  const relay = useSettingControl(settingKeys.remoteRelay, "Relay");
  const url = useSettingControl(settingKeys.relayUrl, "Your own relay");
  const live = useRemoteStatus().data?.networks?.relay;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const own = relay.value && url.value !== "";
  const sub = !relay.value
    ? "Reach this computer through a relay you run, as well as ace's."
    : live?.error
      ? live.error
      : own
        ? `On through ${addressWords(url.value)}.`
        : "On through ace's relay.";
  const busy = relay.offline || relay.pending || url.pending;
  const save = async () => {
    const next = draft.trim();
    if (!next) return;
    await url.set(next);
    if (!relay.value) await relay.set(true);
    setEditing(false);
  };
  return (
    <HairlineRow
      id="remote.relay"
      title="Your own relay"
      sub={
        <>
          {relay.value ? <StateWords tone={live?.error ? "warn" : "on"}>{sub}</StateWords> : sub}
          {editing && (
            <form
              aria-label="Your own relay"
              className="relative z-1 mt-2 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Input
                aria-label="Relay address"
                autoFocus
                value={draft}
                placeholder="wss://relay.example.com/"
                onChange={(event) => setDraft(event.currentTarget.value)}
                className="w-64"
              />
              <Button type="submit" size="sm" variant="primary" disabled={busy || !draft.trim()}>
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </form>
          )}
        </>
      }
      actions={
        !editing && (
          <DaemonSlot control={url}>
            {relay.value && (
              <RowAction
                reveal
                disabled={busy}
                onClick={() => {
                  void url.set("");
                  void relay.set(false);
                }}
              >
                Remove
              </RowAction>
            )}
            <RowAction
              className="text-foreground"
              disabled={busy}
              onClick={() => {
                setDraft(url.value);
                setEditing(true);
              }}
            >
              {own ? "Edit" : "Add"}
            </RowAction>
          </DaemonSlot>
        )
      }
    />
  );
}

function RemoteAccessSwitch(props: { dependents: readonly string[] }) {
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const [risky, setRisky] = useState<Confirming>();
  const turnOff = () =>
    props.dependents.length
      ? setRisky({
          title: "Turn off remote access?",
          body: `${listNames(props.dependents)} reach this computer through remote access. They disconnect until it's turned on again.`,
          confirm: "Turn off",
          run: () => void enabled.set(false),
        })
      : void enabled.set(false);
  return (
    <>
      <HairlineRow
        id="remote.enabled"
        title={enabled.value ? "Turn off remote access" : "Turn on remote access"}
        sub={
          enabled.value
            ? "Disconnects every device and machine until you turn it on again."
            : "Off. Only this computer can open it."
        }
        actions={
          <DaemonSlot control={enabled}>
            <RowAction
              tone={enabled.value ? "danger" : "default"}
              className={enabled.value ? undefined : "text-foreground"}
              aria-label={enabled.value ? "Turn off remote access" : "Turn on remote access"}
              disabled={enabled.offline || enabled.pending}
              onClick={() => (enabled.value ? turnOff() : void enabled.set(true))}
            >
              {enabled.value ? "Turn off" : "Turn on"}
            </RowAction>
          </DaemonSlot>
        }
      />
      <ConfirmDialog confirming={risky} onDone={() => setRisky(undefined)} />
    </>
  );
}

function HostedLinks() {
  const hosted = useSettingControl(
    settingKeys.hostedPairingLink,
    "Pairing links open app.acehq.dev",
  );
  return (
    <HairlineRow
      id="remote.hostedPairingLink"
      title="Pairing links open app.acehq.dev"
      sub={
        hosted.value
          ? "On. Links open ace's web app, which may run another version."
          : "Off. They open the web app this computer serves."
      }
      actions={
        <DaemonSlot control={hosted}>
          <RowAction
            reveal={hosted.value}
            className={hosted.value ? undefined : "text-foreground"}
            aria-label={`${hosted.value ? "Turn off" : "Turn on"} pairing links that open app.acehq.dev`}
            disabled={hosted.offline || hosted.pending}
            onClick={() => void hosted.set(!hosted.value)}
          >
            {hosted.value ? "Turn off" : "Turn on"}
          </RowAction>
        </DaemonSlot>
      }
    />
  );
}
