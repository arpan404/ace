import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRelayConnectionUrl } from "@ace/shared/relay";

const originalWindow = globalThis.window;
const originalIndexedDb = globalThis.indexedDB;

function setWindowStorageForTest() {
  const localStorageState = new Map<string, string>();
  const eventTarget = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => localStorageState.get(key) ?? null,
        setItem: (key: string, value: string) => {
          localStorageState.set(key, value);
        },
        removeItem: (key: string) => {
          localStorageState.delete(key);
        },
      },
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    },
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: undefined,
  });
  return localStorageState;
}

describe("relaySecureStorage", () => {
  afterEach(() => {
    vi.resetModules();
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
    if (originalIndexedDb === undefined) {
      Reflect.deleteProperty(globalThis, "indexedDB");
    } else {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: originalIndexedDb,
      });
    }
  });

  it("migrates a legacy web relay identity out of localStorage", async () => {
    const localStorageState = setWindowStorageForTest();
    localStorageState.set(
      "ace.relay-device-identity.v1",
      JSON.stringify({
        deviceId: "viewer-device-1",
        createdAt: "2026-04-30T00:00:00.000Z",
        secretKey: "secret-key-1",
        publicKey: "public-key-1",
      }),
    );

    const { loadWebRelayDeviceIdentity } = await import("./relaySecureStorage");
    const identity = await loadWebRelayDeviceIdentity();

    expect(identity).toEqual({
      deviceId: "viewer-device-1",
      createdAt: "2026-04-30T00:00:00.000Z",
      secretKey: "secret-key-1",
      publicKey: "public-key-1",
    });
    expect(localStorageState.get("ace.relay-device-identity.v1")).toBeUndefined();
  });

  it("stores relay secret material outside localStorage and rehydrates it on demand", async () => {
    setWindowStorageForTest();
    const { persistWebRelayConnectionSecrets, resolveWebSecureRelayConnectionUrl } =
      await import("./relaySecureStorage");
    const fullUrl = buildRelayConnectionUrl({
      version: 1,
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      pairingId: "session-1",
      pairingAuthKey: "pairing-auth-key-1",
      hostName: "Workstation",
    });

    const publicUrl = await persistWebRelayConnectionSecrets(fullUrl);

    expect(publicUrl).not.toContain("pairing-auth-key-1");
    expect(await resolveWebSecureRelayConnectionUrl(publicUrl)).toBe(fullUrl);
  });
});
