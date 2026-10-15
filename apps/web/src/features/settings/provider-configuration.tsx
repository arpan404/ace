import { ProviderConfiguration, type ProviderKind } from "@ace/protocol";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useProviderConfiguration } from "@/lib/provider-configuration.ts";
import { NativeModeRow } from "./native-mode.tsx";

export function ProviderPreferences(props: { provider: ProviderKind; missing: boolean }) {
  const { value, disabled, update } = useProviderConfiguration(props.provider);
  const [path, setPath] = useState<string>();
  const [mb, setMb] = useState<string>();
  const [error, setError] = useState(false);
  const [mbError, setMbError] = useState(false);
  const binary = path ?? value?.binaryPath ?? "";
  const budget = mb ?? (value?.maxCheckpointMb === undefined ? "" : String(value.maxCheckpointMb));
  const commitBudget = () => {
    if (budget === (value?.maxCheckpointMb === undefined ? "" : String(value.maxCheckpointMb)))
      return;
    if (budget.trim() === "") {
      setMbError(false);
      void update((row) => {
        const { maxCheckpointMb: _before, ...rest } = row;
        return rest;
      }).then((saved) => {
        if (saved) setMb(undefined);
      });
      return;
    }
    const parsed = ProviderConfiguration.shape.maxCheckpointMb.safeParse(Number(budget));
    if (!parsed.success) {
      setMbError(true);
      return;
    }
    setMbError(false);
    void update((row) => ({ ...row, maxCheckpointMb: parsed.data })).then((saved) => {
      if (saved) setMb(undefined);
    });
  };
  return (
    <SettingSection label="Provider settings">
      <SettingRow title="Turn off provider" htmlFor="provider-enabled" inline>
        <Switch
          id="provider-enabled"
          checked={value?.enabled === false}
          disabled={disabled || props.missing}
          onCheckedChange={(off) => void update((row) => ({ ...row, enabled: !off }))}
        />
      </SettingRow>
      {props.provider !== "cursor" && (
        <SettingRow
          title="CLI path"
          {...(props.provider === "acp" ? {} : { htmlFor: "provider-path" })}
        >
          {props.provider === "acp" ? (
            <span className="text-sm text-muted-foreground">
              Uses the command approved when the agent was added.
            </span>
          ) : (
            <Input
              id="provider-path"
              value={binary}
              placeholder="Automatic"
              className="min-w-0"
              onChange={(event) => setPath(event.target.value)}
              disabled={disabled}
              onBlur={() => {
                if (binary === (value?.binaryPath ?? "")) return;
                if (binary && !ProviderConfiguration.shape.binaryPath.safeParse(binary).success) {
                  setError(true);
                  return;
                }
                setError(false);
                void update((row) => {
                  const { binaryPath: _before, ...rest } = row;
                  return binary ? { ...rest, binaryPath: binary } : rest;
                }).then((saved) => {
                  if (saved) setPath(undefined);
                });
              }}
            />
          )}
        </SettingRow>
      )}
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          Enter the full path to the executable, or clear it to find the CLI automatically.
        </p>
      )}
      {props.provider === "cursor" && (
        <SettingRow title="Checkpoint budget per thread" htmlFor="cursor-checkpoint-mb">
          <span className="flex min-w-0 items-center gap-2">
            <Input
              id="cursor-checkpoint-mb"
              value={budget}
              placeholder="32"
              inputMode="numeric"
              className="min-w-0"
              onChange={(event) => setMb(event.target.value)}
              disabled={disabled}
              onBlur={commitBudget}
            />
            <span className="shrink-0 text-sm text-muted-foreground">MB</span>
          </span>
        </SettingRow>
      )}
      {mbError && (
        <p role="alert" className="text-sm text-status-failed">
          Enter a whole number of megabytes from 1 to 256, or clear it for the default.
        </p>
      )}
      {!props.missing && <NativeModeRow provider={props.provider} />}
    </SettingSection>
  );
}
