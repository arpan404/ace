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
const RELAY_SECURE_DB_NAME = "ace-relay-secure-storage";
const RELAY_SECURE_DB_VERSION = 1;
const RELAY_SECURE_STORE_NAME = "secrets";
const RELAY_DEVICE_IDENTITY_RECORD_KEY = "relay-device-identity";
const RELAY_CONNECTION_SECRET_PREFIX = "relay-connection:";

const secureMemoryFallback = new Map<string, string>();
let openDatabasePromise: Promise<IDBDatabase | null> | null = null;
let cachedIdentity: RelayStoredDeviceIdentity | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

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

function relayConnectionSecretRecordKey(storageKey: string): string {
  return `${RELAY_CONNECTION_SECRET_PREFIX}${storageKey}`;
}

function openSecureDatabase(): Promise<IDBDatabase | null> {
  if (openDatabasePromise) {
    return openDatabasePromise;
  }
  if (!hasIndexedDb()) {
    openDatabasePromise = Promise.resolve(null);
    return openDatabasePromise;
  }
  openDatabasePromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(RELAY_SECURE_DB_NAME, RELAY_SECURE_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RELAY_SECURE_STORE_NAME)) {
          database.createObjectStore(RELAY_SECURE_STORE_NAME);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          openDatabasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return openDatabasePromise;
}

async function readSecureValue(key: string): Promise<string | null> {
  const database = await openSecureDatabase();
  if (!database) {
    return secureMemoryFallback.get(key) ?? null;
  }
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(RELAY_SECURE_STORE_NAME, "readonly");
      const request = transaction.objectStore(RELAY_SECURE_STORE_NAME).get(key);
      request.onsuccess = () => {
        const result = request.result;
        resolve(typeof result === "string" ? result : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeSecureValue(key: string, value: string): Promise<boolean> {
  const database = await openSecureDatabase();
  if (!database) {
    secureMemoryFallback.set(key, value);
    return false;
  }
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(RELAY_SECURE_STORE_NAME, "readwrite");
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
      transaction.objectStore(RELAY_SECURE_STORE_NAME).put(value, key);
    } catch {
      resolve(false);
    }
  });
}

async function deleteSecureValue(key: string): Promise<void> {
  secureMemoryFallback.delete(key);
  const database = await openSecureDatabase();
  if (!database) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(RELAY_SECURE_STORE_NAME, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
      transaction.objectStore(RELAY_SECURE_STORE_NAME).delete(key);
    } catch {
      resolve();
    }
  });
}

export async function loadWebRelayDeviceIdentity(): Promise<RelayStoredDeviceIdentity> {
  if (cachedIdentity) {
    return cachedIdentity;
  }
  const storedIdentity = await readSecureValue(RELAY_DEVICE_IDENTITY_RECORD_KEY);
  if (storedIdentity) {
    try {
      const parsed = JSON.parse(storedIdentity) as unknown;
      if (isRelayStoredDeviceIdentity(parsed)) {
        cachedIdentity = parsed;
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(LEGACY_RELAY_DEVICE_IDENTITY_STORAGE_KEY);
        }
        return parsed;
      }
    } catch {
      // Ignore malformed secure storage content and rotate below.
    }
  }

  if (typeof window !== "undefined") {
    const legacyIdentity = window.localStorage.getItem(LEGACY_RELAY_DEVICE_IDENTITY_STORAGE_KEY);
    if (legacyIdentity) {
      try {
        const parsed = JSON.parse(legacyIdentity) as unknown;
        if (isRelayStoredDeviceIdentity(parsed)) {
          cachedIdentity = parsed;
          await writeSecureValue(RELAY_DEVICE_IDENTITY_RECORD_KEY, JSON.stringify(parsed));
          window.localStorage.removeItem(LEGACY_RELAY_DEVICE_IDENTITY_STORAGE_KEY);
          return parsed;
        }
      } catch {
        window.localStorage.removeItem(LEGACY_RELAY_DEVICE_IDENTITY_STORAGE_KEY);
      }
    }
  }

  const created = createRelayDeviceIdentity();
  cachedIdentity = created;
  await writeSecureValue(RELAY_DEVICE_IDENTITY_RECORD_KEY, JSON.stringify(created));
  return created;
}

export async function persistWebRelayConnectionSecrets(connectionUrl: string): Promise<string> {
  const split = splitRelayConnectionSecrets(connectionUrl);
  if (!split.storageKey || !split.secrets) {
    return split.connectionUrl;
  }
  const persisted = await writeSecureValue(
    relayConnectionSecretRecordKey(split.storageKey),
    JSON.stringify(split.secrets),
  );
  return persisted ? split.connectionUrl : connectionUrl;
}

export async function resolveWebSecureRelayConnectionUrl(connectionUrl: string): Promise<string> {
  const metadata = parseRelayConnectionUrl(connectionUrl);
  if (!metadata) {
    return connectionUrl;
  }
  if (metadata.pairingAuthKey || metadata.pairingSecret) {
    return connectionUrl;
  }
  const persistedSecrets = await readSecureValue(
    relayConnectionSecretRecordKey(relayConnectionStorageKey(metadata)),
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

export async function deleteWebRelayConnectionSecrets(connectionUrl: string): Promise<void> {
  const metadata = parseRelayConnectionUrl(connectionUrl);
  if (!metadata) {
    return;
  }
  await deleteSecureValue(relayConnectionSecretRecordKey(relayConnectionStorageKey(metadata)));
}
