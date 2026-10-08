import type { ProviderKind } from "@ace/protocol";
import { usePermissionModes } from "@/lib/use-permission-modes.ts";
import { Select } from "./ui/select.tsx";
export function NativePermissionSelect(props: {
  provider: ProviderKind | undefined;
  value: string | undefined;
  onChange(value: string | undefined): void;
}) {
  const { modes, loading } = usePermissionModes(props.provider);
  const value = modes.some((mode) => mode.id === props.value) ? props.value : "";
  return (
    <Select
      label="Permissions"
      value={value ?? ""}
      disabled={loading}
      options={[
        { value: "", label: "Provider default" },
        ...modes.map((mode) => ({ value: mode.id, label: mode.label })),
      ]}
      onValueChange={(id) => props.onChange(id || undefined)}
    />
  );
}
