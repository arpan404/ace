import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveDaemonHome } from "@ace/service/home";
import { resolveTarget } from "./target.ts";

const options = (platform: NodeJS.Platform) => ({
  packaged: true,
  daemonEntry: "/app/daemon/ace.mjs",
  readToken: () => "",
  platform,
  homedir: tmpdir(),
  resolveHome: resolveDaemonHome,
});

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
