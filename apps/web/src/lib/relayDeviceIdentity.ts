import { createRelayDeviceIdentity, type RelayStoredDeviceIdentity } from "@ace/shared/relay";

const RELAY_DEVICE_IDENTITY_STORAGE_KEY = "ace.relay-device-identity.v1";

function isRelayStoredDeviceIdentity(value: unknown): value is RelayStoredDeviceIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deviceId === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.secretKey === "string" &&
    typeof candidate.publicKey === "string"
  );
}

export async function loadWebRelayDeviceIdentity(): Promise<RelayStoredDeviceIdentity> {
  if (typeof window === "undefined") {
    return createRelayDeviceIdentity();
  }
  const existing = window.localStorage.getItem(RELAY_DEVICE_IDENTITY_STORAGE_KEY);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (isRelayStoredDeviceIdentity(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore invalid persisted identity and rotate below.
    }
  }
  const created = createRelayDeviceIdentity();
  window.localStorage.setItem(RELAY_DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(created));
  return created;
}
