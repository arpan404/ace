import { describe, expect, it } from "vitest";

import { resolveThreadOriginConnectionUrl } from "./useConnectionServerProviders";

describe("resolveThreadOriginConnectionUrl", () => {
  it("prefers the explicit connection for split-pane and routed remote drafts", () => {
    expect(
      resolveThreadOriginConnectionUrl({
        explicitConnectionUrl: "ws://remote-explicit/ws",
        threadConnectionUrl: "ws://remote-thread/ws",
        routeConnectionUrl: "ws://remote-route/ws",
        projectConnectionUrl: "ws://remote-project/ws",
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://remote-explicit/ws");
  });

  it("falls back to the persisted thread owner before the route connection", () => {
    expect(
      resolveThreadOriginConnectionUrl({
        threadConnectionUrl: "ws://remote-thread/ws",
        routeConnectionUrl: "ws://remote-route/ws",
        projectConnectionUrl: "ws://remote-project/ws",
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://remote-thread/ws");
  });

  it("uses the project owner for drafts before falling back to the route", () => {
    expect(
      resolveThreadOriginConnectionUrl({
        routeConnectionUrl: "ws://remote-route/ws",
        projectConnectionUrl: "ws://remote-project/ws",
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://remote-project/ws");
  });

  it("falls back to the route connection and then local when no ownership exists", () => {
    expect(
      resolveThreadOriginConnectionUrl({
        routeConnectionUrl: "ws://remote-route/ws",
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://remote-route/ws");

    expect(
      resolveThreadOriginConnectionUrl({
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://local/ws");
  });
});
