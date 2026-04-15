import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostInstance } from "../hostInstances";
import type { MobileWsClient } from "./mobileWsClient";

vi.mock("./mobileWsClient", () => ({
  createMobileWsClient: vi.fn(),
}));

import { ConnectionManager } from "./ConnectionManager";
import { createMobileWsClient } from "./mobileWsClient";

function makeHost(overrides: Partial<HostInstance> = {}): HostInstance {
  return {
    id: "host-1",
    name: "Primary",
    wsUrl: "ws://localhost:3773/ws",
    authToken: "token-a",
    clientSessionId: "session-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeClientMock() {
  const cleanupStatus = vi.fn();
  const dispose = vi.fn().mockResolvedValue(undefined);
  const getConfig = vi.fn().mockResolvedValue({});
  const client = {
    onConnectionStateChange: vi.fn().mockReturnValue(cleanupStatus),
    server: {
      getConfig,
    },
    dispose,
  } as unknown as MobileWsClient;

  return { client, cleanupStatus, dispose, getConfig };
}

describe("ConnectionManager", () => {
  const createClientMock = vi.mocked(createMobileWsClient);

  beforeEach(() => {
    createClientMock.mockReset();
  });

  it("emits current state immediately for new subscribers", () => {
    const manager = new ConnectionManager();
    const listener = vi.fn();

    const unsubscribe = manager.onStatusChange(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith([]);
    unsubscribe();
  });

  it("updates host metadata without recreating an existing client", async () => {
    const manager = new ConnectionManager();
    const firstClient = makeClientMock();
    createClientMock.mockReturnValue(firstClient.client);

    await manager.connect(makeHost());
    await manager.connect(
      makeHost({
        name: "Renamed Host",
        lastConnectedAt: "2026-01-01T12:00:00.000Z",
      }),
    );

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(firstClient.cleanupStatus).not.toHaveBeenCalled();
    expect(firstClient.dispose).not.toHaveBeenCalled();

    const [connection] = manager.getConnections();
    expect(connection?.host.name).toBe("Renamed Host");
    expect(connection?.host.lastConnectedAt).toBe("2026-01-01T12:00:00.000Z");
  });

  it("recreates a client when host transport settings change", async () => {
    const manager = new ConnectionManager();
    const firstClient = makeClientMock();
    const secondClient = makeClientMock();

    createClientMock
      .mockReturnValueOnce(firstClient.client)
      .mockReturnValueOnce(secondClient.client);

    await manager.connect(makeHost());
    await manager.connect(makeHost({ wsUrl: "ws://localhost:3774/ws" }));

    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(firstClient.cleanupStatus).toHaveBeenCalledTimes(1);
    expect(firstClient.dispose).toHaveBeenCalledTimes(1);

    const [connection] = manager.getConnections();
    expect(connection?.client).toBe(secondClient.client);
    expect(connection?.host.wsUrl).toBe("ws://localhost:3774/ws");
  });
});
