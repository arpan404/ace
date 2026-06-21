import { randomUUID } from "@ace/shared/ids";
import {
  buildRelayHostConnectionDraft,
  normalizeWsUrl,
  parseHostConnectionQrPayload,
  requestPairingClaim,
  type HostConnectionDraft,
  type HostPairingPayload,
  resolveHostDisplayName,
  waitForPairingApproval,
  wsUrlToBrowserBaseUrl,
} from "@ace/shared/hostConnections";
import { loadMobileRelayDeviceIdentity } from "./relayDeviceIdentity";

export interface HostInstance {
  readonly id: string;
  readonly name: string;
  readonly wsUrl: string;
  readonly authToken: string;
  readonly clientSessionId: string;
  readonly createdAt: string;
  readonly lastConnectedAt?: string;
}

export {
  parseHostConnectionQrPayload,
  requestPairingClaim,
  waitForPairingApproval,
  wsUrlToBrowserBaseUrl,
};

export async function resolvePairingHostConnection(
  pairing: HostPairingPayload,
  options?: {
    readonly requesterName?: string;
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
  },
): Promise<HostConnectionDraft> {
  const requestOptions: { requesterName?: string } = {};
  if (options?.requesterName !== undefined) {
    requestOptions.requesterName = options.requesterName;
  }
  if (pairing.relayUrl && pairing.hostDeviceId && pairing.hostIdentityPublicKey) {
    return buildRelayHostConnectionDraft({
      pairing,
      viewerIdentity: await loadMobileRelayDeviceIdentity(),
    });
  }
  const receipt = await requestPairingClaim(pairing, requestOptions);
  return waitForPairingApproval(receipt, {
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
  });
}

export function createHostInstance(
  draft: HostConnectionDraft,
  existing?: HostInstance,
  nowIso = new Date().toISOString(),
): HostInstance {
  const wsUrl = normalizeWsUrl(draft.wsUrl);
  return {
    id: existing?.id ?? randomUUID(),
    name: resolveHostDisplayName(draft.name, wsUrl),
    wsUrl,
    authToken: draft.authToken?.trim() ?? existing?.authToken ?? "",
    clientSessionId: existing?.clientSessionId ?? randomUUID(),
    createdAt: existing?.createdAt ?? nowIso,
    ...(existing?.lastConnectedAt ? { lastConnectedAt: existing.lastConnectedAt } : {}),
  };
}
