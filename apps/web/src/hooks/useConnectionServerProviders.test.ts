import { DEFAULT_SERVER_SETTINGS, type ServerConfig, ProjectId, ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  applyConnectionServerConfigEvent,
  resolveThreadOriginConnectionUrl,
} from "./useConnectionServerProviders";

function buildServerConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    cwd: "/tmp/ace-project",
    keybindingsConfigPath: "/tmp/ace-project/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    settings: DEFAULT_SERVER_SETTINGS,
    ...overrides,
  };
}

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

describe("applyConnectionServerConfigEvent", () => {
  it("replaces the cached config on snapshot events", () => {
    const snapshot = buildServerConfig({
      cwd: "/tmp/remote-project",
      providers: [
        {
          provider: "codex",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-05-01T00:00:00.000Z",
          models: [],
        },
      ],
    });

    expect(
      applyConnectionServerConfigEvent(null, {
        version: 1,
        type: "snapshot",
        config: snapshot,
      }),
    ).toEqual(snapshot);
  });

  it("updates remote providers without losing settings", () => {
    const current = buildServerConfig({
      providers: [
        {
          provider: "claudeAgent",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "error",
          auth: { status: "unauthenticated" },
          checkedAt: "2026-05-01T00:00:00.000Z",
          message: "Not logged in",
          models: [],
        },
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            customModels: ["gpt-5.5-custom"],
          },
        },
      },
    });

    const next = applyConnectionServerConfigEvent(current, {
      version: 1,
      type: "providerStatuses",
      payload: {
        providers: [
          {
            provider: "codex",
            enabled: true,
            installed: true,
            version: "1.1.0",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-05-01T00:01:00.000Z",
            models: [],
          },
        ],
      },
    });

    expect(next?.providers.map((provider) => provider.provider)).toEqual(["codex"]);
    expect(next?.settings.providers.codex.customModels).toEqual(["gpt-5.5-custom"]);
  });

  it("updates remote settings without losing provider statuses", () => {
    const current = buildServerConfig({
      providers: [
        {
          provider: "codex",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-05-01T00:00:00.000Z",
          models: [],
        },
      ],
    });

    const nextSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          customModels: ["gpt-5.4-remote"],
        },
      },
    };

    const next = applyConnectionServerConfigEvent(current, {
      version: 1,
      type: "settingsUpdated",
      payload: {
        settings: nextSettings,
      },
    });

    expect(next?.providers.map((provider) => provider.provider)).toEqual(["codex"]);
    expect(next?.settings.providers.codex.customModels).toEqual(["gpt-5.4-remote"]);
  });
});
