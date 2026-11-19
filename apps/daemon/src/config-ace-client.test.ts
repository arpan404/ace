import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { readConfig } from "./config.ts";

// How the daemon names itself to ace cloud and the market (`ace-client`, ADR 0189).

const named = (version: string | undefined) =>
  readConfig(
    {
      ACE_HOME: join(tmpdir(), "ace-client-name-home"),
      ACE_PORT: "0",
      ...(version === undefined ? {} : { ACE_VERSION: version }),
    },
    tmpdir(),
  ).aceClient;

it("names a released daemon by its version, beta prerelease included", () => {
  expect(named("0.0.24-beta.1")).toBe("daemon/0.0.24-beta.1");
  expect(named("0.0.24")).toBe("daemon/0.0.24");
});

it("names a daemon run without a version a development build", () => {
  expect(named(undefined)).toBe("daemon/development");
  expect(named("development")).toBe("daemon/development");
});

it("sends no name for a version it can't read rather than misnaming itself", () => {
  expect(named("not a version")).toBeUndefined();
});
