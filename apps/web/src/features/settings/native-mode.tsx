import { useConnectionState } from "@ace/client-react";
import type { ProviderKind } from "@ace/protocol";
import { permissionModeLabel } from "@ace/ui-core";
import { SettingRow } from "@/components/setting-row.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useNativeModes } from "@/lib/use-permission-modes.ts";

const aceModes = "";

/**
 * Advanced: run one of the provider's own modes instead of ace's four. Its threads' access chip
 * then reads Custom. Off unless chosen here.
 */
export function NativeModeRow(props: { provider: ProviderKind }) {
  const [native, set] = useDaemonSetting("access.nativeModes");
  const { modes, loading } = useNativeModes(props.provider);
  const offline = useConnectionState() !== "ready";
  const toast = useToast();
  const value = native?.[props.provider] ?? aceModes;
  if (!loading && !modes.length && value === aceModes) return null;
  return (
    <SettingRow title="Native mode" inline>
      <Select
        label="Native mode"
        className="w-56"
        value={value}
        disabled={offline || loading || native === undefined}
        options={[
          { value: aceModes, label: "Use ace modes" },
          ...modes.map((mode) => ({ value: mode.id, label: permissionModeLabel(mode) })),
          ...(value && !modes.some((mode) => mode.id === value)
            ? [{ value, label: value, disabled: true }]
            : []),
        ]}
        onValueChange={(picked) => {
          const next = { ...native };
          if (picked) next[props.provider] = picked;
          else delete next[props.provider];
          void set(next).catch(() =>
            toast.error({
              title: "Couldn't save native mode",
              description: "Reconnect and try again.",
            }),
          );
        }}
      />
    </SettingRow>
  );
}
