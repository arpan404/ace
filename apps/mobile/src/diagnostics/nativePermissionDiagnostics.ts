export type NativePermissionKind = "notifications" | "camera" | "photo-library";

export interface NativePermissionProbeResult {
  readonly granted: boolean;
  readonly canAskAgain?: boolean | null;
  readonly status?: string | null;
}

export interface NativePermissionDiagnosticsProbe {
  readonly kind: NativePermissionKind;
  readonly label: string;
  readonly getPermission: () => Promise<NativePermissionProbeResult>;
}

export interface NativePermissionDiagnosticsStatus {
  readonly kind: NativePermissionKind;
  readonly label: string;
  readonly state: "granted" | "blocked" | "not-granted";
  readonly detail: string;
}

function summarizePermission(permission: NativePermissionProbeResult): {
  readonly state: NativePermissionDiagnosticsStatus["state"];
  readonly detail: string;
} {
  if (permission.granted) {
    return { state: "granted", detail: "Granted" };
  }
  if (permission.canAskAgain === false) {
    return { state: "blocked", detail: "Blocked in system settings" };
  }
  return {
    state: "not-granted",
    detail: permission.status ? `Not granted (${permission.status})` : "Not granted",
  };
}

export async function runNativePermissionDiagnostics(
  probes: ReadonlyArray<NativePermissionDiagnosticsProbe>,
): Promise<ReadonlyArray<NativePermissionDiagnosticsStatus>> {
  return Promise.all(
    probes.map(async (probe) => {
      const summary = summarizePermission(await probe.getPermission());
      return {
        kind: probe.kind,
        label: probe.label,
        ...summary,
      };
    }),
  );
}
