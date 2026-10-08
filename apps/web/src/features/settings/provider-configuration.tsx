import type { ProviderKind } from "@ace/protocol";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useProviderConfiguration } from "@/lib/provider-configuration.ts";

export function ProviderPreferences(props: { provider: ProviderKind }) {
  const { value, disabled, update } = useProviderConfiguration(props.provider);
  const [path, setPath] = useState<string>();
  const [error, setError] = useState(false);
  const binary = path ?? value?.binaryPath ?? "";
  return (
    <SettingSection label="Configuration" scope="daemon">
      <SettingRow title="Enable provider" htmlFor="provider-enabled" inline>
        <Switch
          id="provider-enabled"
          checked={value?.enabled !== false}
          disabled={disabled}
          onCheckedChange={(enabled) => void update((row) => ({ ...row, enabled }))}
        />
      </SettingRow>
      <SettingRow title="CLI path" htmlFor="provider-path">
        <form
          className="flex min-w-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (binary && !/^(?:\/|[A-Za-z]:[\\/])/.test(binary)) {
              setError(true);
              return;
            }
            setError(false);
            void update((row) => {
              const { binaryPath: _before, ...rest } = row;
              return binary ? { ...rest, binaryPath: binary } : rest;
            });
          }}
        >
          <Input
            id="provider-path"
            value={binary}
            placeholder="Automatic"
            className="min-w-0"
            onChange={(event) => setPath(event.target.value)}
            disabled={disabled}
          />
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            disabled={disabled || binary === (value?.binaryPath ?? "")}
          >
            Save
          </Button>
        </form>
      </SettingRow>
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          Enter the full path to the executable, or clear it to find the CLI automatically.
        </p>
      )}
    </SettingSection>
  );
}
