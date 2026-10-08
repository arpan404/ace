import type { ProviderKind } from "@ace/protocol";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { NativePermissionSelect } from "@/components/native-permission-select.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
export function ProviderPermissions(props: { provider: ProviderKind }) {
  const [modes, setModes] = useDaemonSetting("permissions.providerModes");
  return (
    <SettingSection label="Permissions" scope="daemon">
      <SettingRow
        title="New threads"
        description="The provider handles approvals using its own permissions."
      >
        <NativePermissionSelect
          provider={props.provider}
          value={modes?.[props.provider]}
          onChange={(mode) => {
            const next = { ...modes };
            if (mode) next[props.provider] = mode;
            else delete next[props.provider];
            void setModes(next);
          }}
        />
      </SettingRow>
    </SettingSection>
  );
}
