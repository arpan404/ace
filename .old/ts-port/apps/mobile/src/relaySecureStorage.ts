import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import {
  createRelayDeviceIdentity,
  mergeRelayConnectionSecrets,
  parseRelayConnectionUrl,
  relayConnectionStorageKey,
  splitRelayConnectionSecrets,
  type RelayConnectionSecretMaterial,
  type RelayStoredDeviceIdentity,
} from "@ace/shared/relay";

const LEGACY_RELAY_DEVICE_IDENTITY_STORAGE_KEY = "ace.relay-device-identity.v1";
const RELAY_DEVICE_IDENTITY_SECURE_KEY = "ace.relay-device-identity.secure.v1";
const RELAY_CONNECTION_SECRET_PREFIX = "ace.relay-connection.secure.v1:";

const secureMemoryFallback = new Map<string, string>();
let cachedIdentity: RelayStoredDeviceIdentity | null = null;

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

function isRelayConnectionSecretMaterial(value: unknown): value is RelayConnectionSecretMaterial {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pairingAuthKey === "string" || typeof candidate.pairingSecret === "string"
  );
}

function relayConnectionSecretKey(storageKey: string): string {
  return `${RELAY_CONNECTION_SECRET_PREFIX}${storageKey}`;
}

async function readSecureValue(key: string): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(key);
    return value ?? secureMemoryFallback.get(key) ?? null;
  } catch {
    return secureMemoryFallback.get(key) ?? null;
  }
}

async function writeSecureValue(key: string, value: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value);
    secureMemoryFallback.set(key, value);
    return true;
  } catch {
    secureMemoryFallback.set(key, value);
    return false;
  }
}

async function deleteSecureValue(key: string): Promise<void> {
  secureMemoryFallback.delete(key);
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Ignore secure storage cleanup failures.
  }
}

export async function loadMobileRelayDeviceIdentity(): Promise<RelayStoredDeviceIdentity> {
  if (cachedIdentity) {
    return cachedIdentity;
  }
  const secureIdentity = await readSecureValue(RELAY_DEVICE_IDENTITY_SECURE_KEY);
  if (secureIdentity) {
    try {
      const parsed = JSON.parse(secureIdentity) as unknown;
      if (isRelayStoredDeviceIdentity(parsed)) {
        cachedIdentity = parsed;
        await AsyncStorage.removeItem(LEGACY_RELAY_DEVICE_IDENTITY_STORAGE_KEY).catch(
          () => undefined,
        );
        return parsed;
      }
    } catch {
      // Ignore malformed secure state and rotate below.
    }
  }

  const legacyIdentity = await AsyncStorage.getItem(LEGACY_RELAY_DEVICE_IDENTITY_STORAGE_KEY);
  if (legacyIdentity) {
    try {
      const parsed = JSON.parse(legacyIdentity) as unknown;
      if (isRelayStoredDeviceIdentity(parsed)) {
        cachedIdentity = parsed;
        await writeSecureValue(RELAY_DEVICE_IDENTITY_SECURE_KEY, JSON.stringify(parsed));
        await AsyncStorage.removeItem(LEGACY_RELAY_DEVICE_IDENTITY_STORAGE_KEY).catch(
          () => undefined,
        );
        return parsed;
      }
    } catch {
      await AsyncStorage.removeItem(LEGACY_RELAY_DEVICE_IDENTITY_STORAGE_KEY).catch(
        () => undefined,
      );
    }
  }

  const created = createRelayDeviceIdentity();
  cachedIdentity = created;
  await writeSecureValue(RELAY_DEVICE_IDENTITY_SECURE_KEY, JSON.stringify(created));
  return created;
}

export async function persistMobileRelayConnectionSecrets(connectionUrl: string): Promise<string> {
  const split = splitRelayConnectionSecrets(connectionUrl);
  if (!split.storageKey || !split.secrets) {
    return split.connectionUrl;
  }
  const persisted = await writeSecureValue(
    relayConnectionSecretKey(split.storageKey),
    JSON.stringify(split.secrets),
  );
  return persisted ? split.connectionUrl : connectionUrl;
}

export async function resolveMobileSecureRelayConnectionUrl(
  connectionUrl: string,
): Promise<string> {
  const metadata = parseRelayConnectionUrl(connectionUrl);
  if (!metadata) {
    return connectionUrl;
  }
  if (metadata.pairingAuthKey || metadata.pairingSecret) {
    return connectionUrl;
  }
  const persistedSecrets = await readSecureValue(
    relayConnectionSecretKey(relayConnectionStorageKey(metadata)),
  );
  if (!persistedSecrets) {
    return connectionUrl;
  }
  try {
    const parsed = JSON.parse(persistedSecrets) as unknown;
    if (!isRelayConnectionSecretMaterial(parsed)) {
      return connectionUrl;
    }
    return mergeRelayConnectionSecrets(connectionUrl, parsed);
  } catch {
    return connectionUrl;
  }
}

export async function deleteMobileRelayConnectionSecrets(connectionUrl: string): Promise<void> {
  const metadata = parseRelayConnectionUrl(connectionUrl);
  if (!metadata) {
    return;
  }
  await deleteSecureValue(relayConnectionSecretKey(relayConnectionStorageKey(metadata)));
}
