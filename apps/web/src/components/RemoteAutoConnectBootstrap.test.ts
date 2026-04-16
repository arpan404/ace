import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  shouldCleanupBootstrapQuery,
  shouldProbeActiveRemoteHost,
} from "./RemoteAutoConnectBootstrap";

describe("shouldCleanupBootstrapQuery", () => {
  it("returns true when bootstrap ws query param is present", () => {
    expect(
      shouldCleanupBootstrapQuery(
        `?${DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM}=${encodeURIComponent("ws://127.0.0.1:6060/ws")}`,
      ),
    ).toBe(true);
  });

  it("returns false when bootstrap ws query param is absent", () => {
    expect(shouldCleanupBootstrapQuery("?tab=settings")).toBe(false);
  });
});

describe("shouldProbeActiveRemoteHost", () => {
  it("returns false without an active ws override", () => {
    expect(
      shouldProbeActiveRemoteHost({
        activeWsOverride: undefined,
        localDeviceWsUrl: "ws://127.0.0.1:3773/ws",
      }),
    ).toBe(false);
  });

  it("returns false when active override points to local device", () => {
    expect(
      shouldProbeActiveRemoteHost({
        activeWsOverride: "ws://127.0.0.1:3773/ws",
        localDeviceWsUrl: "ws://127.0.0.1:3773/ws",
      }),
    ).toBe(false);
  });

  it("returns true when active override targets a remote host", () => {
    expect(
      shouldProbeActiveRemoteHost({
        activeWsOverride: "ws://10.0.0.8:3773/ws?token=remote",
        localDeviceWsUrl: "ws://127.0.0.1:3773/ws",
      }),
    ).toBe(true);
  });
});
