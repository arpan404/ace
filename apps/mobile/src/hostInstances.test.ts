import { beforeEach, describe, expect, it, vi } from "vitest";

const reactNativeMock = vi.hoisted(() => ({
  NativeModules: {} as { SourceCode?: { scriptURL?: string } },
  Platform: { OS: "ios" },
}));

vi.mock("react-native", () => reactNativeMock);

vi.mock("./relayDeviceIdentity", () => ({
  loadMobileRelayDeviceIdentity: vi.fn(),
}));

import { createDefaultHostInstance, createHostInstance } from "./hostInstances";

describe("createHostInstance", () => {
  beforeEach(() => {
    reactNativeMock.NativeModules.SourceCode = undefined;
    reactNativeMock.Platform.OS = "ios";
    delete process.env.EXPO_PUBLIC_ACE_HOST;
    delete process.env.EXPO_PUBLIC_ACE_PORT;
    delete process.env.EXPO_PUBLIC_ACE_WS_URL;
  });

  it("normalizes new direct host connection drafts", () => {
    const host = createHostInstance(
      {
        name: "  Workstation  ",
        wsUrl: "localhost:3773",
        authToken: " token-a ",
      },
      undefined,
      "2026-05-02T00:00:00.000Z",
    );

    expect(host.name).toBe("Workstation");
    expect(host.wsUrl).toBe("ws://localhost:3773/ws");
    expect(host.authToken).toBe("token-a");
    expect(host.createdAt).toBe("2026-05-02T00:00:00.000Z");
  });

  it("preserves host identity and session metadata when editing connection details", () => {
    const existing = {
      id: "host-1",
      name: "Laptop",
      wsUrl: "ws://old-host.local:3773/ws",
      authToken: "old-token",
      clientSessionId: "session-1",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-02T01:00:00.000Z",
    };

    const host = createHostInstance(
      {
        name: "Desk",
        wsUrl: "http://new-host.local:3774",
        authToken: " new-token ",
      },
      existing,
      "2026-05-03T00:00:00.000Z",
    );

    expect(host).toEqual({
      id: "host-1",
      name: "Desk",
      wsUrl: "ws://new-host.local:3774/ws",
      authToken: "new-token",
      clientSessionId: "session-1",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-02T01:00:00.000Z",
    });
  });

  it("infers the Expo bundle host and dev-runner port for default hosts", () => {
    reactNativeMock.NativeModules.SourceCode = {
      scriptURL: "http://192.168.1.24:8081/index.bundle?platform=ios",
    };
    process.env.EXPO_PUBLIC_ACE_PORT = "3888";

    const host = createDefaultHostInstance("2026-05-02T00:00:00.000Z");

    expect(host.wsUrl).toBe("ws://192.168.1.24:3888/ws");
  });

  it("uses platform loopback defaults when Expo host inference is unavailable", () => {
    const iosHost = createDefaultHostInstance("2026-05-02T00:00:00.000Z");
    expect(iosHost.wsUrl).toBe("ws://127.0.0.1:3773/ws");

    reactNativeMock.Platform.OS = "android";
    const androidHost = createDefaultHostInstance("2026-05-02T00:00:00.000Z");
    expect(androidHost.wsUrl).toBe("ws://10.0.2.2:3773/ws");
  });
});
