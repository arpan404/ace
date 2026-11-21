import { useConnectionState } from "@ace/client-react";
import {
  betaSwitches,
  mediaPipelineRefused,
  mediaPipelineState,
  mediaPipelineSwitch,
  mediaPipelineValue,
} from "@ace/ui-core";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { useSetting, useSettingsBackend } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { SettingSwitch } from "./setting-switch.tsx";
import { settingRow } from "./settings-index.ts";

/** Features still being tried out on this machine, each one switch that goes back freely. */
export function BetaSettings() {
  return (
    <>
      <SettingSection label="Features" scope="daemon">
        <SettingSwitch
          setting={settingKeys.betaSpade}
          entry="beta.spade"
          description={betaSwitches.spade.description}
        />
        <SettingSwitch
          setting={settingKeys.betaMarketplace}
          entry="beta.marketplace"
          description={betaSwitches.marketplace.description}
        />
        <SettingSwitch
          setting={settingKeys.marketAskBeforeAgentPublish}
          entry="market.askBeforeAgentPublish"
        />
      </SettingSection>
      <SettingSection label="Video" scope="daemon">
        <MediaPipelineRow />
      </SettingSection>
    </>
  );
}

/**
 * The new media pipeline (ADR 0147): one switch over `media.delivery` (ace-media always encodes).
 * A failed write says so in the row, and the switch keeps showing what the daemon holds.
 *
 * Delivery is chosen when a view subscribes (the bridges' `bindMedia`), so a view already open
 * keeps its path until it is opened again.
 */
function MediaPipelineRow() {
  const id = useId();
  const row = settingRow("beta.mediaPipeline");
  const [delivery, setDelivery] = useSetting(settingKeys.mediaDelivery);
  const loaded = useMediaSettingsLoaded();
  const offline = useConnectionState() !== "ready";
  const [saving, setSaving] = useState(false);
  const [slow, setSlow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [error, setError] = useState<string>();
  const { on } = mediaPipelineState(delivery);

  const turn = async (next: boolean) => {
    const value = mediaPipelineValue(next);
    setSaving(true);
    setError(undefined);
    // A spinner only once the write is slow, as every settings control does.
    timer.current = setTimeout(() => setSlow(true), 400);
    // The write rolls back on its own if the daemon refuses it, so the row shows what's stored.
    try {
      await setDelivery(value);
    } catch (failure) {
      setError(mediaPipelineRefused(next, failure instanceof Error ? failure.message : undefined));
    } finally {
      clearTimeout(timer.current);
      setSaving(false);
      setSlow(false);
    }
  };

  return (
    <SettingRow
      id={row.id}
      title={row.title}
      htmlFor={id}
      inline
      description={
        <>
          <span className="block">{mediaPipelineSwitch.description}</span>
          {error && (
            <span role="alert" className="block text-destructive">
              {error}
            </span>
          )}
        </>
      }
    >
      <DaemonSlot control={{ loaded, offline, pending: slow }}>
        <Switch
          id={id}
          checked={on}
          disabled={offline || saving}
          onCheckedChange={(next) => void turn(next)}
        />
      </DaemonSlot>
    </SettingRow>
  );
}

/** The delivery setting has come from the daemon, so the switch never shows a fallback. */
function useMediaSettingsLoaded(): boolean {
  const backend = useSettingsBackend();
  const loaded = () => settingKeys.mediaDelivery.key in backend.values.get();
  return useSyncExternalStore(backend.values.subscribe, loaded, loaded);
}
