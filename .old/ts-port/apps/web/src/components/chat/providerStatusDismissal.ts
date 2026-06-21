import type { ServerProvider } from "@ace/contracts";

export function resolveProviderStatusDismissalKey(status: ServerProvider | null): string | null {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }
  return [
    status.provider,
    status.providerInstanceId ?? "default",
    status.status,
    status.auth.status,
    status.message ?? "",
  ].join(":");
}
