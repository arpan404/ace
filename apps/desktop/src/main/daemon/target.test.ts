import { describe, expect, it } from "vitest";
import { newerDataMessage } from "./exit-policy.ts";
import { resolveTarget, type HomePreparer, type HomeResolver } from "./target.ts";

/** A stand-in for the shared resolver: platform rules don't depend on what's on disk. */
const homes: HomeResolver = (home, requested) => requested ?? `${home}/.ace`;
const untouched: HomePreparer = () => undefined;
const options = (
  platform: NodeJS.Platform,
  prepareHome: HomePreparer = untouched,
  packaged = true,
) => ({
  packaged,
  daemonEntry: "/app/daemon/ace.mjs",
  readToken: () => "",
  platform,
  homedir: "/Users/me",
  resolveHome: homes,
  prepareHome,
});
const refuse =
  (name: string, message: string): HomePreparer =>
  () => {
    throw Object.assign(new Error(message), { name });
  };

describe("which daemon the packaged app uses", () => {
  it("manages a local daemon on macOS and Linux", () => {
    expect(resolveTarget({ ACE_HOME: "/h" }, options("darwin")).kind).toBe("managed");
    expect(resolveTarget({ ACE_HOME: "/h" }, options("linux")).kind).toBe("managed");
  });

  it("asks for a remote daemon on Windows instead of starting one that cannot run", () => {
    expect(resolveTarget({}, options("win32"))).toMatchObject({ kind: "remote-only" });
  });

  it("uses a configured remote daemon on any platform", () => {
    expect(
      resolveTarget(
        {
          ACE_DAEMON_URL: "wss://box.example:4242/",
          ACE_DAEMON_TOKEN: "a".repeat(64),
          ACE_DAEMON_DEVICE_ID: "paired",
        },
        options("win32"),
      ),
    ).toMatchObject({ kind: "remote", url: "wss://box.example:4242/" });
  });
});

describe("the managed daemon's home", () => {
  it("names the backup when preparing the home made a fresh start", () => {
    const fresh = { backup: "/Users/me/.ace-v0", previousFormat: "ace-v0" };
    expect(
      resolveTarget(
        {},
        options("darwin", () => fresh),
      ),
    ).toEqual({
      kind: "managed",
      home: "/Users/me/.ace",
      entry: "/app/daemon/ace.mjs",
      fresh,
    });
  });

  it("refuses a home of newer data with the words the supervisor uses for exit 65", () => {
    const newer = refuse("NewerDataError", "data format ace-v9, build supports ace-v1");
    expect(resolveTarget({}, options("darwin", newer))).toEqual({
      kind: "refused",
      reason: newerDataMessage,
    });
  });

  it("refuses, with the reason, a home whose older daemon is still running", () => {
    const live = refuse("LiveHomeError", "an older ace daemon (pid 7) is still using it");
    expect(resolveTarget({}, options("darwin", live))).toEqual({
      kind: "refused",
      reason: "an older ace daemon (pid 7) is still using it",
    });
  });
});

describe("development's attach mode", () => {
  it("takes the dev daemon's home as it is and leaves preparing it to that daemon", () => {
    const attach = { ACE_DESKTOP_DAEMON: "attach", ACE_HOME: "/Users/me/.ace-dev/home" } as const;
    const never = refuse("Error", "attach must not prepare the home");
    expect(resolveTarget(attach, options("darwin", never, false))).toEqual({
      kind: "attach",
      home: "/Users/me/.ace-dev/home",
    });
  });
});

it("carries the paired device identity from remote desktop configuration", () => {
  expect(
    resolveTarget(
      {
        ACE_DAEMON_URL: "wss://remote.example/",
        ACE_DAEMON_TOKEN: "a".repeat(64),
        ACE_DAEMON_DEVICE_ID: "paired-device",
      },
      options("win32"),
    ),
  ).toEqual({
    kind: "remote",
    url: "wss://remote.example/",
    token: "a".repeat(64),
    pairedDeviceId: "paired-device",
  });
});

it("remote desktop configuration refuses a host token without paired device identity", () => {
  expect(() =>
    resolveTarget(
      { ACE_DAEMON_URL: "wss://remote.example/", ACE_DAEMON_TOKEN: "a".repeat(64) },
      options("win32"),
    ),
  ).toThrow("ACE_DAEMON_DEVICE_ID");
});
