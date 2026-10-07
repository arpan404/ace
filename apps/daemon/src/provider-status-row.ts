import { ProviderStatus, type ProviderStatus as Status } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";

/** Invalid optional observations cannot erase a separately established installation. */
export function providerStatusRow(
  row: Status,
  observation: DiscoveryResult | undefined,
  at: number,
): Status {
  const shape = ProviderStatus.shape;
  const installed = shape.installed.safeParse(observation?.installed);
  const auth = shape.auth.safeParse(observation?.auth);
  const hint = shape.loginHint.safeParse(observation?.loginHint);
  const result: Status = {
    provider: row.provider,
    runtime: row.runtime,
    installed: installed.success ? installed.data : null,
    auth: auth.success ? auth.data : "unknown",
    loginHint: hint.success ? hint.data : row.loginHint,
    checkedAt: at,
    stale: false,
    refreshing: false,
  };
  if (result.installed && result.auth === "logged_out") {
    result.state = "not_configured";
    result.actionId = "provider.sign_in";
    if (result.provider === "cursor") result.loginHint = "Sign in to Cursor";
  }
  let invalid = false;
  const path = shape.path.safeParse(observation?.path);
  if (path.success && path.data !== undefined) result.path = path.data;
  else if (!path.success) invalid = true;
  const version = shape.version.safeParse(observation?.version);
  if (version.success && version.data !== undefined) result.version = version.data;
  else if (!version.success) invalid = true;
  const label = shape.accountLabel.safeParse(observation?.accountLabel);
  if (label.success && label.data !== undefined) result.accountLabel = label.data;
  else if (!label.success) invalid = true;
  const detail = shape.authDetail.safeParse(observation?.authDetail);
  if (detail.success && detail.data !== undefined) result.authDetail = detail.data;
  else if (!detail.success) invalid = true;
  const evidence = shape.authEvidence.safeParse(observation?.authEvidence);
  if (evidence.success && evidence.data !== undefined) result.authEvidence = evidence.data;
  else if (!evidence.success) invalid = true;
  const error = shape.error.safeParse(observation?.error);
  if (error.success && error.data !== undefined) result.error = error.data;
  else if (!error.success) invalid = true;
  if (invalid) result.error = "Invalid optional provider metadata";
  return result;
}
