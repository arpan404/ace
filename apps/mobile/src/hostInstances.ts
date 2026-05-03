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
import { NativeModules, Platform } from "react-native";
import { loadMobileRelayDeviceIdentity } from "./relayDeviceIdentity";

const DEFAULT_ACE_PORT = 3773;

export interface HostInstance {
  readonly id: string;
  readonly name: string;
  readonly wsUrl: string;
  readonly authToken: string;
  readonly clientSessionId: string;
  readonly createdAt: string;
  readonly lastConnectedAt?: string;
}

export interface HostInstanceDraft {
  readonly name?: string;
  readonly wsUrl: string;
  readonly authToken?: string;
}

function normalizePort(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_ACE_PORT;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_ACE_PORT;
  }
  return parsed;
}

function sourceScriptUrl(): string | undefined {
  const sourceCode = NativeModules.SourceCode as { scriptURL?: string } | undefined;
  const value = sourceCode?.scriptURL?.trim();
  return value && value.length > 0 ? value : undefined;
}

function hostnameFromUrl(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}

function inferDesktopHost(): string {
  const configuredHost = process.env.EXPO_PUBLIC_ACE_HOST?.trim();
  if (configuredHost && configuredHost.length > 0) {
    return configuredHost;
  }

  const scriptUrl = sourceScriptUrl();
  const fromBundleHost = scriptUrl ? hostnameFromUrl(scriptUrl) : undefined;
  if (
    fromBundleHost &&
    fromBundleHost.length > 0 &&
    fromBundleHost !== "localhost" &&
    fromBundleHost !== "127.0.0.1"
  ) {
    return fromBundleHost;
  }

  if (Platform.OS === "android") {
    return "10.0.2.2";
  }
  return "10.0.2.2";
}

function inferDefaultWsUrl(): string {
  const configured = process.env.EXPO_PUBLIC_ACE_WS_URL?.trim();
  if (configured && configured.length > 0) {
    return normalizeWsUrl(configured);
  }
  const host = inferDesktopHost();
  const port = normalizePort(process.env.EXPO_PUBLIC_ACE_PORT);
  return `ws://${host}:${String(port)}/ws`;
}

export {
  normalizeWsUrl,
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
  if (pairing.relayUrl && pairing.hostDeviceId && pairing.hostIdentityPublicKey) {
    return buildRelayHostConnectionDraft({
      pairing,
      viewerIdentity: await loadMobileRelayDeviceIdentity(),
    });
  }
  const receipt = await requestPairingClaim(
    pairing,
    options?.requesterName ? { requesterName: options.requesterName } : {},
  );
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

export function createDefaultHostInstance(nowIso = new Date().toISOString()): HostInstance {
  return {
    id: randomUUID(),
    name: "Primary ace host",
    wsUrl: inferDefaultWsUrl(),
    authToken: "",
    clientSessionId: randomUUID(),
    createdAt: nowIso,
  };
}
