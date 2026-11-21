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
 * The new media pipeline (ADR 0147): one switch over `media.encode`. `media.delivery` is always
 * `auto` (X3), so it isn't written here. A failed write says so in the row, and the switch keeps
 * showing what the daemon holds. Producers follow `media.encode` at their next keyframe.
 */
function MediaPipelineRow() {
  const id = useId();
  const row = settingRow("beta.mediaPipeline");
  const [encode, setEncode] = useSetting(settingKeys.mediaEncode);
  const loaded = useMediaSettingsLoaded();
  const offline = useConnectionState() !== "ready";
  const [saving, setSaving] = useState(false);
  const [slow, setSlow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [error, setError] = useState<string>();
  const { on } = mediaPipelineState(encode);

  const turn = async (next: boolean) => {
    const value = mediaPipelineValue(next);
    setSaving(true);
    setError(undefined);
    // A spinner only once the write is slow, as every settings control does.
    timer.current = setTimeout(() => setSlow(true), 400);
    // The write rolls back on its own if the daemon refuses it, so the row shows what's stored.
    const results = await Promise.allSettled([setEncode(value)]);
    clearTimeout(timer.current);
    setSaving(false);
    setSlow(false);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      const reason = failed.reason instanceof Error ? failed.reason.message : undefined;
      setError(mediaPipelineRefused(next, reason));
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

/** The media setting has come from the daemon, so the switch never shows a fallback. */
function useMediaSettingsLoaded(): boolean {
  const backend = useSettingsBackend();
  const loaded = () => settingKeys.mediaEncode.key in backend.values.get();
  return useSyncExternalStore(backend.values.subscribe, loaded, loaded);
}
