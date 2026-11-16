import { useConnectionState } from "@ace/client-react";
import {
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
import { settingRow } from "./settings-index.ts";

/** Features still being tried out on this machine, each one switch that goes back freely. */
export function BetaSettings() {
  return (
    <SettingSection label="Video" scope="daemon">
      <MediaPipelineRow />
    </SettingSection>
  );
}

/**
 * The new media pipeline (ADR 0147): one switch over `media.encode` and `media.delivery`. On
 * means both are `auto`; anything else shows off, and a mixed pair says only part is on. A
 * failed write says so in the row, and the switch keeps showing what the daemon holds.
 *
 * Producers follow `media.encode` at their next keyframe, but `media.delivery` is chosen when a
 * view subscribes (the bridges' `bindMedia`), so a view already open keeps its path until it
 * is opened again.
 */
function MediaPipelineRow() {
  const id = useId();
  const row = settingRow("beta.mediaPipeline");
  const [encode, setEncode] = useSetting(settingKeys.mediaEncode);
  const [delivery, setDelivery] = useSetting(settingKeys.mediaDelivery);
  const loaded = useMediaSettingsLoaded();
  const offline = useConnectionState() !== "ready";
  const [saving, setSaving] = useState(false);
  const [slow, setSlow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [error, setError] = useState<string>();
  const { on, partly } = mediaPipelineState(encode, delivery);

  const turn = async (next: boolean) => {
    const value = mediaPipelineValue(next);
    setSaving(true);
    setError(undefined);
    // A spinner only once the write is slow, as every settings control does.
    timer.current = setTimeout(() => setSlow(true), 400);
    // Each write rolls back on its own if the daemon refuses it, so the row shows what's stored.
    const results = await Promise.allSettled([setEncode(value), setDelivery(value)]);
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
          {partly && <span className="block">{mediaPipelineSwitch.partly}</span>}
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

/** Both media settings have come from the daemon, so the switch never shows a fallback. */
function useMediaSettingsLoaded(): boolean {
  const backend = useSettingsBackend();
  const both = () => {
    const values = backend.values.get();
    return settingKeys.mediaEncode.key in values && settingKeys.mediaDelivery.key in values;
  };
  return useSyncExternalStore(backend.values.subscribe, both, both);
}
