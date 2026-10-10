import { useConnectionState } from "@ace/client-react";
import { WorkspaceId, type PermissionCapabilities, type ProviderKind } from "@ace/protocol";
import { composerPermissionDefault, composerPermissionOption, providerNames } from "@ace/ui-core";
import { SettingRow } from "./setting-row.tsx";
import { Select, type SelectOption } from "./ui/select.tsx";
import { useToast } from "./ui/toast.tsx";
import { useDaemonSetting, useLocalPermissionModes } from "@/lib/daemon-setting.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import { usePermissionCapabilities } from "@/lib/use-permission-modes.ts";

/** Defaults are native selections for each provider, with project overrides kept separately. */
export function PermissionDefaults(props: { workspaceId?: string }) {
  const statuses = useProviderStatuses();
  const providers = [
    ...new Set(
      (statuses.data ?? [])
        .filter((row) => row.state !== "not_installed")
        .map((row) => row.provider),
    ),
  ];
  return (
    <>
      {providers.map((provider) => (
        <PermissionDefault key={provider} provider={provider} workspaceId={props.workspaceId} />
      ))}
    </>
  );
}
function PermissionDefault(props: { provider: ProviderKind; workspaceId?: string | undefined }) {
  const scope = props.workspaceId ? { workspaceId: WorkspaceId.parse(props.workspaceId) } : {};
  const [effective, set] = useDaemonSetting("permissions.providerModes", scope);
  const local = useLocalPermissionModes(scope);
  const { capabilities, loading, failed } = usePermissionCapabilities(props.provider);
  const offline = useConnectionState() !== "ready";
  const toast = useToast();
  const title = `${providerNames[props.provider]} permissions`;
  const automatic = composerPermissionDefault(
    props.provider,
    effective?.[props.provider],
    capabilities,
  );
  const value =
    local?.[props.provider] ??
    (props.workspaceId ? "" : loading ? "loading" : (automatic ?? "unavailable"));
  const choices = capabilities?.permissionModes ?? [];
  const options = nativeDefaultOptions(props.provider, capabilities, value, !!props.workspaceId);
  const inherited =
    props.workspaceId && !value
      ? choices.find((mode) => mode.id === effective?.[props.provider])?.label
      : undefined;
  return (
    <SettingRow
      title={providerNames[props.provider]}
      inline
      description={
        failed
          ? "Couldn't load permission modes. Reconnect and try again."
          : inherited
            ? `Global default: ${inherited}`
            : !loading && automatic === null
              ? "No supported permission mode is available."
              : undefined
      }
    >
      <Select
        label={title}
        value={value}
        options={options}
        disabled={offline || local === undefined || loading || failed || choices.length === 0}
        onValueChange={(next) => {
          const modes = { ...local };
          if (next) modes[props.provider] = next;
          else delete modes[props.provider];
          void set(
            modes,
            props.workspaceId
              ? { kind: "workspace", workspaceId: WorkspaceId.parse(props.workspaceId) }
              : { kind: "global" },
          ).catch(() =>
            toast.error({
              title: "Couldn't save permissions",
              description: "Reconnect and try again.",
            }),
          );
        }}
      />
    </SettingRow>
  );
}

/** Native choices include unavailable saved values without turning them into new selections. */
function nativeDefaultOptions(
  provider: ProviderKind,
  capabilities: PermissionCapabilities | undefined,
  value: string,
  inherit: boolean,
): SelectOption<string>[] {
  const choices = capabilities?.permissionModes ?? [];
  const options: SelectOption<string>[] = [
    ...(inherit ? [{ value: "", label: "Use global default" }] : []),
    ...choices.map((mode) => ({
      value: mode.id,
      label: composerPermissionOption(provider, mode.id, capabilities).label,
    })),
  ];
  if (
    value &&
    value !== "unavailable" &&
    value !== "loading" &&
    !choices.some((choice) => choice.id === value)
  )
    options.push({ value, label: "Saved choice unavailable" });
  if (value === "loading") options.push({ value, label: "Loading approvals…", disabled: true });
  if (value === "unavailable")
    options.push({ value, label: "Permissions unavailable", disabled: true });
  return options;
}
