import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRelayConnectionUrl } from "@ace/shared/relay";

const asyncStorageState = new Map<string, string>();
const secureStoreState = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorageState.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStorageState.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStorageState.delete(key);
    }),
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreState.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStoreState.delete(key);
  }),
}));

describe("relaySecureStorage", () => {
  beforeEach(() => {
    vi.resetModules();
    asyncStorageState.clear();
    secureStoreState.clear();
  });

  it("migrates a legacy mobile relay identity into secure storage", async () => {
    asyncStorageState.set(
      "ace.relay-device-identity.v1",
      JSON.stringify({
        deviceId: "viewer-device-1",
        createdAt: "2026-04-30T00:00:00.000Z",
        secretKey: "secret-key-1",
        publicKey: "public-key-1",
      }),
    );

    const { loadMobileRelayDeviceIdentity } = await import("./relaySecureStorage");
    const identity = await loadMobileRelayDeviceIdentity();

    expect(identity).toEqual({
      deviceId: "viewer-device-1",
      createdAt: "2026-04-30T00:00:00.000Z",
      secretKey: "secret-key-1",
      publicKey: "public-key-1",
    });
    expect(asyncStorageState.has("ace.relay-device-identity.v1")).toBe(false);
    expect(secureStoreState.get("ace.relay-device-identity.secure.v1")).toBeTruthy();
  });

  it("stores relay route secrets in secure storage and rehydrates public relay urls", async () => {
    const { persistMobileRelayConnectionSecrets, resolveMobileSecureRelayConnectionUrl } =
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

    const publicUrl = await persistMobileRelayConnectionSecrets(fullUrl);

    expect(publicUrl).not.toContain("pairing-auth-key-1");
    expect(await resolveMobileSecureRelayConnectionUrl(publicUrl)).toBe(fullUrl);
  });
});
