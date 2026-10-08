import type { PermissionCapabilities, PermissionMode, PermissionState } from "@ace/protocol";
export function permissionLabel(
  mode: PermissionMode | null | undefined,
  capabilities?: PermissionCapabilities,
): string {
  return mode
    ? (capabilities?.permissionModes?.find((entry) => entry.id === mode)?.label ?? "Saved mode")
    : "Provider default";
}
export const permissionShortLabel = permissionLabel;
export function permissionChipText(
  mode: PermissionMode | null,
  next: PermissionMode | undefined,
  capabilities?: PermissionCapabilities,
): string {
  return next
    ? `${permissionLabel(mode, capabilities)} → ${permissionLabel(next, capabilities)}`
    : permissionLabel(mode, capabilities);
}
export type PermissionWait = "busy";
export function permissionPendingNote(wait?: PermissionWait): string {
  return wait === "busy"
    ? "Applies when the running command finishes"
    : "Applies at the agent's next turn";
}
export function permissionNeedsAttention(
  mode: PermissionMode | null,
  capabilities?: PermissionCapabilities,
): boolean {
  return capabilities?.permissionModes?.find((entry) => entry.id === mode)?.risk === "high";
}
export function permissionCoverage(
  capabilities: PermissionCapabilities | undefined,
  mode: PermissionMode | null,
): string {
  return (
    capabilities?.permissionModes?.find((entry) => entry.id === mode)?.description ??
    "Uses the provider's configured permissions"
  );
}
export function permissionCoverageNote(
  _capabilities: PermissionCapabilities | undefined,
  provider: string,
  _mode: PermissionMode | null | undefined,
): string {
  return `${provider} handles permission decisions`;
}
export interface PermissionChoice {
  mode: PermissionMode;
  label: string;
  description: string;
  coverage: string;
  attention: boolean;
  unavailable?: string | undefined;
}
export function permissionUnavailable(
  capabilities: PermissionCapabilities | undefined,
  mode: PermissionMode | null,
  provider: string,
): string | undefined {
  if (mode === null || !capabilities?.permissionModes) return undefined;
  return capabilities.permissionModes.some((entry) => entry.id === mode)
    ? undefined
    : `${provider} doesn't offer this mode`;
}
export function permissionFallback(
  capabilities: PermissionCapabilities | undefined,
  mode: PermissionMode | null,
): PermissionMode | null {
  if (
    mode === null ||
    !capabilities?.permissionModes ||
    capabilities.permissionModes.some((entry) => entry.id === mode)
  )
    return mode;
  return capabilities.permissionModes.find((entry) => entry.default)?.id ?? null;
}
export interface PermissionAdmission {
  mode: PermissionMode | undefined;
  fallback: string | undefined;
}
export function permissionAdmission(
  capabilities: PermissionCapabilities | undefined,
  requested: PermissionMode | null | undefined,
  _provider: string,
): PermissionAdmission {
  return {
    mode: permissionFallback(capabilities, requested ?? null) ?? undefined,
    fallback: undefined,
  };
}
export function permissionChoices(
  capabilities: PermissionCapabilities | undefined,
  _provider = "This provider",
): PermissionChoice[] {
  return (capabilities?.permissionModes ?? []).map((entry) => ({
    mode: entry.id,
    label: entry.label,
    description: entry.description,
    coverage: entry.description,
    attention: entry.risk === "high",
  }));
}
export interface PermissionSummary {
  mode: PermissionMode | null;
  label: string;
  attention: boolean;
  coverage: string;
  next: PermissionMode | undefined;
  inherited: boolean;
}
export function threadPermissionSummary(
  state: PermissionState | undefined,
  capabilities: PermissionCapabilities | undefined,
  options: {
    chosen?: PermissionMode | null | undefined;
    defaultMode?: PermissionMode | null | undefined;
  } = {},
): PermissionSummary | undefined {
  if (!state) return undefined;
  const override = options.chosen !== undefined ? options.chosen : state.override;
  const target = override ?? options.defaultMode;
  return {
    mode: state.effective,
    label: permissionLabel(state.effective, capabilities),
    attention: permissionNeedsAttention(state.effective, capabilities),
    coverage: permissionCoverage(capabilities, state.effective),
    next:
      (options.chosen !== undefined || state.pending) && target && target !== state.effective
        ? target
        : undefined,
    inherited: override === null,
  };
}

/** The provider's native option as the composer's generic risk-based control reads it. */
export type PermissionRisk = "low" | "medium" | "high";
export interface PermissionOption {
  id: string;
  label: string;
  description: string;
  risk: PermissionRisk;
  unavailable?: string | undefined;
}
export function permissionOption(
  mode: PermissionMode | null,
  capabilities?: PermissionCapabilities,
): PermissionOption {
  const entry = capabilities?.permissionModes?.find((candidate) => candidate.id === mode);
  return {
    id: mode ?? "",
    label: permissionLabel(mode, capabilities),
    description: permissionCoverage(capabilities, mode),
    risk: entry?.risk ?? "medium",
  };
}
export function permissionOptions(
  capabilities: PermissionCapabilities | undefined,
  _provider = "This provider",
): PermissionOption[] {
  return (capabilities?.permissionModes ?? []).map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    risk: entry.risk,
  }));
}
