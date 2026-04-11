import Crypto from "node:crypto";
import Fs from "node:fs/promises";
import Path from "node:path";

const HOST_TOKEN_FILE_NAME = "relay-host-token";
const DEFAULT_RELAY_SERVER_URL = "http://10.0.0.228:9091";

type RelayDeviceIcon = "iphone" | "ipad" | "laptop" | "desktop" | "watch";

export interface RelayDeviceView {
  readonly deviceId: string;
  readonly name: string;
  readonly icon: RelayDeviceIcon;
  readonly apiKey: string;
  readonly createdAt: string;
  readonly lastResolvedAt?: string;
  readonly revokedAt?: string;
  readonly activeConnectionCount: number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRelayApiError(payload: unknown): string | null {
  if (!isObjectRecord(payload) || typeof payload.error !== "string") {
    return null;
  }
  const message = payload.error.trim();
  return message.length > 0 ? message : null;
}

async function parseRelayApiResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Relay server returned malformed JSON.");
  }
}

function resolveRelayServerBaseUrl(): string {
  const configured = process.env.ACE_RELAY_SERVER_URL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_RELAY_SERVER_URL;
}

function buildRelayUrl(pathname: string): string {
  return new URL(pathname, resolveRelayServerBaseUrl()).toString();
}

async function relayRequest<TResponse>(
  path: string,
  options?: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly parse: (payload: unknown) => TResponse;
  },
): Promise<TResponse> {
  const response = await fetch(buildRelayUrl(path), {
    method: options?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
    },
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await parseRelayApiResponse(response);
  if (!response.ok) {
    const message = parseRelayApiError(payload);
    throw new Error(message ?? `Relay request failed with status ${String(response.status)}.`);
  }
  if (!options?.parse) {
    throw new Error("Relay request parser is required.");
  }
  return options.parse(payload);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assertRelayDevice(payload: unknown): RelayDeviceView {
  if (!isObjectRecord(payload)) {
    throw new Error("Relay device response was invalid.");
  }
  if (
    typeof payload.deviceId !== "string" ||
    typeof payload.name !== "string" ||
    typeof payload.icon !== "string" ||
    typeof payload.apiKey !== "string" ||
    typeof payload.createdAt !== "string" ||
    typeof payload.activeConnectionCount !== "number"
  ) {
    throw new Error("Relay device response was missing required fields.");
  }
  return {
    deviceId: payload.deviceId,
    name: payload.name,
    icon: payload.icon as RelayDeviceIcon,
    apiKey: payload.apiKey,
    createdAt: payload.createdAt,
    ...(typeof payload.lastResolvedAt === "string"
      ? { lastResolvedAt: payload.lastResolvedAt }
      : {}),
    ...(typeof payload.revokedAt === "string" ? { revokedAt: payload.revokedAt } : {}),
    activeConnectionCount: payload.activeConnectionCount,
  };
}

async function readOrCreateRelayHostToken(stateDir: string): Promise<string> {
  const path = Path.join(stateDir, HOST_TOKEN_FILE_NAME);
  try {
    const existing = (await Fs.readFile(path, "utf8")).trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // Create a new host token below.
  }
  const nextToken = `ace_host_${Crypto.randomBytes(24).toString("base64url")}`;
  await Fs.writeFile(path, `${nextToken}\n`, { mode: 0o600 });
  return nextToken;
}

export interface RelayHostSnapshot {
  readonly hostToken: string;
  readonly relayUrl: string;
  readonly wsUrl: string;
  readonly devices: readonly RelayDeviceView[];
}

export async function registerRelayHost(input: {
  readonly stateDir: string;
  readonly wsUrl: string;
}): Promise<{ readonly hostToken: string; readonly wsUrl: string }> {
  const hostToken = await readOrCreateRelayHostToken(input.stateDir);
  return relayRequest("/v1/hosts/register", {
    method: "POST",
    body: {
      hostToken,
      wsUrl: input.wsUrl,
    },
    parse: (payload) => {
      if (!isObjectRecord(payload)) {
        throw new Error("Relay register response was invalid.");
      }
      if (typeof payload.hostToken !== "string" || typeof payload.wsUrl !== "string") {
        throw new Error("Relay register response was missing hostToken/wsUrl.");
      }
      return {
        hostToken: payload.hostToken,
        wsUrl: payload.wsUrl,
      };
    },
  });
}

export async function listRelayDevicesForHost(input: {
  readonly stateDir: string;
  readonly wsUrl: string;
}): Promise<RelayHostSnapshot> {
  const registration = await registerRelayHost(input);
  return relayRequest(`/v1/hosts/${encodeURIComponent(registration.hostToken)}/devices`, {
    parse: (payload) => {
      if (!isObjectRecord(payload) || !Array.isArray(payload.devices)) {
        throw new Error("Relay devices response was invalid.");
      }
      if (
        typeof payload.hostToken !== "string" ||
        typeof payload.relayUrl !== "string" ||
        typeof payload.wsUrl !== "string"
      ) {
        throw new Error("Relay devices response was missing hostToken/relayUrl/wsUrl.");
      }
      return {
        hostToken: payload.hostToken,
        relayUrl: payload.relayUrl,
        wsUrl: payload.wsUrl,
        devices: payload.devices.map((device) => assertRelayDevice(device)),
      };
    },
  });
}

export async function createRelayDeviceForHost(input: {
  readonly stateDir: string;
  readonly wsUrl: string;
  readonly name?: string;
  readonly icon?: RelayDeviceIcon;
}): Promise<RelayHostSnapshot> {
  const registration = await registerRelayHost(input);
  const created = await relayRequest("/v1/hosts/device-tokens", {
    method: "POST",
    body: {
      hostToken: registration.hostToken,
      ...(asNonEmptyString(input.name) ? { name: input.name?.trim() } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
    },
    parse: (payload) => {
      if (!isObjectRecord(payload) || !payload.device) {
        throw new Error("Relay create device response was invalid.");
      }
      if (
        typeof payload.hostToken !== "string" ||
        typeof payload.relayUrl !== "string" ||
        typeof payload.wsUrl !== "string"
      ) {
        throw new Error("Relay create device response was missing hostToken/relayUrl/wsUrl.");
      }
      return {
        hostToken: payload.hostToken,
        relayUrl: payload.relayUrl,
        wsUrl: payload.wsUrl,
        device: assertRelayDevice(payload.device),
      };
    },
  });
  return {
    hostToken: created.hostToken,
    relayUrl: created.relayUrl,
    wsUrl: created.wsUrl,
    devices: [created.device],
  };
}

export async function revokeRelayDeviceForHost(input: {
  readonly stateDir: string;
  readonly wsUrl: string;
  readonly deviceId: string;
}): Promise<RelayHostSnapshot> {
  const registration = await registerRelayHost(input);
  const revoked = await relayRequest(
    `/v1/hosts/${encodeURIComponent(registration.hostToken)}/devices/${encodeURIComponent(input.deviceId)}/revoke`,
    {
      method: "POST",
      body: {},
      parse: (payload) => {
        if (!isObjectRecord(payload) || !payload.device) {
          throw new Error("Relay revoke response was invalid.");
        }
        if (
          typeof payload.hostToken !== "string" ||
          typeof payload.relayUrl !== "string" ||
          typeof payload.wsUrl !== "string"
        ) {
          throw new Error("Relay revoke response was missing hostToken/relayUrl/wsUrl.");
        }
        return {
          hostToken: payload.hostToken,
          relayUrl: payload.relayUrl,
          wsUrl: payload.wsUrl,
          device: assertRelayDevice(payload.device),
        };
      },
    },
  );
  return {
    hostToken: revoked.hostToken,
    relayUrl: revoked.relayUrl,
    wsUrl: revoked.wsUrl,
    devices: [revoked.device],
  };
}

export async function verifyRelayApiKeyForHost(input: {
  readonly stateDir: string;
  readonly apiKey: string;
  readonly wsUrl?: string;
}): Promise<{ readonly valid: boolean }> {
  const hostToken = input.wsUrl
    ? (
        await registerRelayHost({
          stateDir: input.stateDir,
          wsUrl: input.wsUrl,
        })
      ).hostToken
    : await readOrCreateRelayHostToken(input.stateDir);
  return relayRequest("/v1/verify", {
    method: "POST",
    body: {
      hostToken,
      apiKey: input.apiKey,
    },
    parse: (payload) => {
      if (!isObjectRecord(payload) || payload.valid !== true) {
        throw new Error("Relay verify response was invalid.");
      }
      return { valid: true };
    },
  });
}

export async function publishRelayConnectionActivity(input: {
  readonly stateDir: string;
  readonly apiKey: string;
  readonly clientSessionId: string;
  readonly connectionId: string;
  readonly status: "connected" | "disconnected";
}): Promise<void> {
  const hostToken = await readOrCreateRelayHostToken(input.stateDir);
  await relayRequest("/v1/activity", {
    method: "POST",
    body: {
      hostToken,
      apiKey: input.apiKey,
      clientSessionId: input.clientSessionId,
      connectionId: input.connectionId,
      status: input.status,
    },
    parse: () => undefined,
  });
}
