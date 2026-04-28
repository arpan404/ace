import { ProjectId, ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadOriginConnectionUrl } from "./useConnectionServerProviders";

describe("resolveThreadOriginConnectionUrl", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");
  const projectId = ProjectId.makeUnsafe("project-1");

  it("prefers the explicit connection for split-pane and routed remote drafts", () => {
    expect(
      resolveThreadOriginConnectionUrl({
        threadId,
        explicitConnectionUrl: "ws://remote-explicit/ws",
        routeConnectionUrl: "ws://remote-route/ws",
        projectId,
        threadConnectionById: {
          [threadId]: "ws://remote-thread/ws",
        },
        projectConnectionById: {
          [projectId]: "ws://remote-project/ws",
        },
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://remote-explicit/ws");
  });

  it("falls back to the persisted thread owner before the route connection", () => {
    expect(
      resolveThreadOriginConnectionUrl({
        threadId,
        routeConnectionUrl: "ws://remote-route/ws",
        projectId,
        threadConnectionById: {
          [threadId]: "ws://remote-thread/ws",
        },
        projectConnectionById: {
          [projectId]: "ws://remote-project/ws",
        },
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://remote-thread/ws");
  });

  it("uses the project owner for drafts before falling back to the route", () => {
    expect(
      resolveThreadOriginConnectionUrl({
        threadId,
        routeConnectionUrl: "ws://remote-route/ws",
        projectId,
        threadConnectionById: {},
        projectConnectionById: {
          [projectId]: "ws://remote-project/ws",
        },
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://remote-project/ws");
  });

  it("falls back to the route connection and then local when no ownership exists", () => {
    expect(
      resolveThreadOriginConnectionUrl({
        threadId,
        routeConnectionUrl: "ws://remote-route/ws",
        projectId,
        threadConnectionById: {},
        projectConnectionById: {},
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://remote-route/ws");

    expect(
      resolveThreadOriginConnectionUrl({
        threadId,
        projectId,
        threadConnectionById: {},
        projectConnectionById: {},
        localConnectionUrl: "ws://local/ws",
      }),
    ).toBe("ws://local/ws");
  });
});
