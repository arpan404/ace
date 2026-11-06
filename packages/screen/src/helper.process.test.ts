import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSupervised } from "@ace/provider-kit/process";
import { expect, it, vi } from "vitest";
import { Helper, type Frame } from "./index.ts";
import { deferred, fakeCommand, ids, target, manager, helperFixture } from "./testing/support.ts";
it("the supervised helper correlates concurrent commands and receives fragmented binary frames", async () => {
  const received = deferred<Frame>();
  const errors: Error[] = [];
  const helper = await Helper.open({
    ...fakeCommand,
    env: { REVERSE_REPLIES: "1" },
    scheduler: { schedule: () => () => {} },
    nextId: ids(),
    onFrame: (value) => received.resolve(value),
    onFailure: (error) => errors.push(error),
  });
  try {
    const [permissions, targets] = await Promise.all([
      helper.request({ op: "permissions" }),
      helper.request({ op: "targets" }),
    ]);
    expect(permissions).toEqual({ screenRecording: true, accessibility: true });
    expect(targets).toMatchObject({ windows: [{ title: "Test" }] });
    await helper.request({
      op: "start",
      sessionId: "test",
      target,
      allowlist: [target.bundleId],
      fps: 10,
    });
    expect(await helper.request({ op: "action", action: { kind: "type", text: "hello" } })).toEqual(
      { action: { kind: "type", text: "hello" } },
    );
    expect((await received.promise).payload.toString()).toBe("jpeg-0");
    expect(errors).toEqual([]);
  } finally {
    await helper.close();
  }
});
it("spawn failure rejects pending helper work", async () => {
  const failed = deferred<Error>();
  let socketPath: string | undefined;
  const helper = await Helper.open({
    command: "/no-such-screen-helper",
    spawn: (options) => {
      socketPath = options.args?.at(-1)?.replace(/^unix:/, "");
      return spawnSupervised(options);
    },
    nextId: ids(),
    onFrame: () => {},
    onFailure: (error) => failed.resolve(error),
  });
  try {
    await expect(helper.request({ op: "permissions" })).rejects.toThrow();
    expect(await failed.promise).toBeInstanceOf(Error);
  } finally {
    await helper.close();
  }
  if (!socketPath) throw new Error("Missing socket path");
  await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("a liveness deadline terminates a silent helper and rejects outstanding work", async () => {
  const callbacks = new Set<() => void>();
  const failed = deferred<Error>();
  const helper = await Helper.open({
    command: process.execPath,
    args: ["-e", "process.stdin.resume()", "--"],
    nextId: ids(),
    scheduler: {
      schedule(callback) {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      },
    },
    onFrame: () => {},
    onFailure: (error) => failed.resolve(error),
  });
  try {
    const request = helper.request({ op: "hello" });
    const rejected = expect(request).rejects.toThrow("timed out");
    for (const callback of callbacks) callback();
    await rejected;
    expect((await failed.promise).message).toContain("timed out");
    await helper.close();
    expect(callbacks.size).toBe(0);
  } finally {
    await helper.close();
  }
});

it.runIf(process.platform !== "win32")(
  "helper permission replies retain platform requirements across the process boundary",
  async () => {
    const helper = await Helper.open({
      ...fakeCommand,
      platform: "linux",
      env: { HOST_REQUIREMENTS: "1" },
      nextId: ids(),
      onFrame: () => {},
      onFailure: () => {},
    });
    try {
      expect(await helper.request({ op: "permissions" })).toMatchObject({
        platform: "linux",
        requirements: [
          {
            kind: "futureBus",
            state: "blocked",
            message: "Enable the desktop bus.",
            futureFact: true,
          },
        ],
      });
    } finally {
      await helper.close();
    }
  },
);

it.runIf(process.platform !== "win32").each(["exit", "socket"])(
  "startup %s preserves the bounded native diagnostic in permission requirements",
  async (mode) => {
    const fixture = await manager(
      { FAILURE_MODE: mode },
      {
        platform: "linux",
        protocolVersion: 2,
        args: [new URL("./testing/fake-helper-startup.ts", import.meta.url).pathname],
      },
    );
    try {
      const permissions = await fixture.screen.permissions();
      expect(permissions.requirements).toMatchObject([
        {
          kind: "desktopConnection",
          state: "blocked",
          message: expect.stringContaining(
            "ScreenCast portal unavailable: org.freedesktop.portal.Desktop has no ScreenCast interface",
          ),
        },
      ]);
      expect(permissions.requirements?.[0]?.message.length).toBeLessThanOrEqual(2048);
      if (mode === "socket")
        expect(permissions.requirements?.[0]?.message).toMatch(/^Frame socket closed:/);
    } finally {
      await fixture.close();
    }
  },
);

it.runIf(process.platform !== "win32").each(["exit", "socket"])(
  "startup %s redacts credentials and host paths before they reach permission requirements",
  async (mode) => {
    const secret = `opaque-startup-${"private".repeat(300)}-credential`;
    const inheritedSecret = "opaque-inherited-environment-credential";
    vi.stubEnv("SCREEN_INHERITED_SECRET", inheritedSecret);
    const fixture = await manager(
      { FAILURE_MODE: mode, SENSITIVE_STARTUP: "1", SCREEN_STARTUP_SECRET: secret },
      {
        platform: "linux",
        protocolVersion: 2,
        redactionContext: { home: "/srv/diagnostic-home" },
        args: [new URL("./testing/fake-helper-startup.ts", import.meta.url).pathname],
      },
    );
    try {
      const permissions = await fixture.screen.permissions();
      const visible = JSON.stringify(permissions);
      expect(permissions.requirements?.[0]?.state).toBe("blocked");
      expect(visible).toContain("ScreenCast portal unavailable");
      expect(visible).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(visible).not.toContain("/srv/diagnostic-home");
      expect(visible).not.toContain(secret);
      expect(visible).not.toContain("privateprivate");
      expect(visible).not.toContain(inheritedSecret);
      expect(visible).toContain("<HOME>");
      expect(visible).toContain("<ENV>");
    } finally {
      vi.unstubAllEnvs();
      await fixture.close();
    }
  },
);

it("Windows non-interactive requirements are readable without a frame pipe", async () => {
  const fixture = await manager(
    {},
    {
      platform: "win32",
      protocolVersion: 2,
      args: [new URL("./testing/fake-helper-inspection.ts", import.meta.url).pathname],
    },
  );
  try {
    expect((await fixture.screen.capabilities())?.inspectionOnly).toBe(true);
    for (const permissions of [
      await fixture.screen.permissions(),
      await fixture.screen.requestPermission("accessibility"),
    ]) {
      expect(permissions.platform).toBe("win32");
      expect(permissions.requirements).toMatchObject([
        {
          kind: "interactiveDesktop",
          state: "blocked",
          message: expect.stringContaining("signed-in session"),
        },
      ]);
      expect(permissions.requirements?.[0]?.message).toContain("session 0");
    }
    await fixture.screen.enable(true);
    await expect(fixture.screen.targets()).rejects.toThrow("signed-in session");
  } finally {
    await fixture.close();
  }
});

it.each(["open_app", "windows"] as const)(
  "%s retries with an interactive helper after a blocked reservation finishes",
  async (operation) => {
    let interactive = false;
    const fixture = await helperFixture("win32", {
      env: { TARGET_BUNDLE: target.bundleId },
      launch: async () => ({
        args: [
          fileURLToPath(
            new URL(
              interactive ? "./testing/fake-helper-v2.ts" : "./testing/fake-helper-inspection.ts",
              import.meta.url,
            ),
          ),
        ],
      }),
    });
    const attempt = () =>
      operation === "open_app"
        ? fixture.manager.openAgentApp(
            target.bundleId,
            { threadId: "thread", agentId: "agent" },
            new AbortController().signal,
          )
        : fixture.manager.listAppWindows(target.bundleId);
    try {
      await expect(attempt()).rejects.toThrow("signed-in session");
      interactive = true;
      expect(await attempt()).toMatchObject({
        windows: [{ windowId: 1, bundleId: target.bundleId }],
        selectedWindowId: 1,
      });
    } finally {
      await fixture.close();
    }
  },
);

it("the last overlapping window reservation releases a blocked helper for retry", async () => {
  let interactive = false;
  const launch = deferred<void>();
  const fixture = await helperFixture("win32", {
    env: { TARGET_BUNDLE: target.bundleId },
    launch: async () => {
      await launch.promise;
      return {
        args: [
          fileURLToPath(
            new URL(
              interactive ? "./testing/fake-helper-v2.ts" : "./testing/fake-helper-inspection.ts",
              import.meta.url,
            ),
          ),
        ],
      };
    },
  });
  const open = () =>
    fixture.manager.openAgentApp(
      target.bundleId,
      { threadId: "thread", agentId: "agent" },
      new AbortController().signal,
    );
  try {
    const results = Promise.allSettled([
      open(),
      fixture.manager.listAppWindows(target.bundleId),
      fixture.manager.permissions(),
    ]);
    launch.resolve();
    const [opening, listing, permissions] = await results;
    expect(opening).toMatchObject({
      status: "rejected",
      reason: { message: expect.stringContaining("signed-in session") },
    });
    expect(listing).toMatchObject({
      status: "rejected",
      reason: { message: expect.stringContaining("signed-in session") },
    });
    expect(permissions).toMatchObject({
      status: "fulfilled",
      value: { requirements: [{ kind: "interactiveDesktop", state: "blocked" }] },
    });
    interactive = true;
    expect(await fixture.manager.listAppWindows(target.bundleId)).toMatchObject({
      selectedWindowId: 1,
    });
    expect(await open()).toMatchObject({
      lifecycle: "live",
      target: { kind: "window", windowId: 1 },
    });
  } finally {
    launch.resolve();
    await fixture.close();
  }
});
