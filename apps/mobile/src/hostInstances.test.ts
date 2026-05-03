import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  NativeModules: {},
  Platform: { OS: "ios" },
}));

vi.mock("./relayDeviceIdentity", () => ({
  loadMobileRelayDeviceIdentity: vi.fn(),
}));

import { createHostInstance } from "./hostInstances";

describe("createHostInstance", () => {
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
});
