import { describe, expect, it } from "vitest";
import { resolveTarget, type HomeResolver } from "./target.ts";

/** A stand-in for the shared resolver: platform rules don't depend on what's on disk. */
const homes: HomeResolver = (home, requested) => requested ?? `${home}/.ace`;
const options = (platform: NodeJS.Platform, resolveHome = homes, packaged = true) => ({
  packaged,
  daemonEntry: "/app/daemon/ace.mjs",
  readToken: () => "",
  platform,
  homedir: "/Users/me",
  resolveHome,
});
const legacyRefusal: HomeResolver = () => {
  throw new Error("Legacy ace data at /Users/me/.ace. Choose a separate ACE_HOME");
};
const addonMissing: HomeResolver = () => {
  throw Object.assign(new Error("Cannot find module '../dist/descriptor.node'"), {
    code: "MODULE_NOT_FOUND",
  });
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
        { ACE_DAEMON_URL: "wss://box.example:4242/", ACE_DAEMON_TOKEN: "a".repeat(64) },
        options("win32"),
      ),
    ).toMatchObject({ kind: "remote", url: "wss://box.example:4242/" });
  });
});

describe("development's attach mode", () => {
  const attach = { ACE_DESKTOP_DAEMON: "attach", ACE_HOME: "/Users/me/.ace" } as const;

  it("refuses an explicit home holding legacy data, as the managed app does", () => {
    expect(resolveTarget(attach, options("darwin", legacyRefusal, false))).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/Legacy ace data/),
    });
  });

  it("takes the dev daemon's home as given when an unpackaged run can't load the shared checks", () => {
    expect(resolveTarget(attach, options("darwin", addonMissing, false))).toEqual({
      kind: "attach",
      home: "/Users/me/.ace",
      isolated: false,
    });
  });

  it("never skips the checks in a packaged app", () => {
    expect(resolveTarget(attach, options("darwin", addonMissing, true))).toMatchObject({
      kind: "refused",
    });
  });
});
