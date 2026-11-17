import { describe, expect, test } from "vitest";
import { cliOutputs } from "@ace/protocol/cli-outputs";
import { browserArtifactLine } from "./browser.ts";
import { deviceIds, deviceListLines } from "./device.ts";
import { machineListLines } from "./machine.ts";
import { grantIds, mcpListLines, mcpRequestLines } from "./mcp.ts";
import { remoteListLines } from "./remote.ts";

const now = 1_800_000_000_000;
const hour = 3_600_000;
const day = 24 * hour;

describe("machine list", () => {
  test("each linked machine by the name agents use, then whether it answers", () => {
    const golden = cliOutputs["machine.list"].parse({
      machines: [
        {
          profile: "studio",
          name: "Studio Mac",
          origin: "https://a",
          deviceId: "d1",
          status: "online",
          access: "operate",
        },
        { profile: "pi", name: "pi", origin: "https://b", deviceId: "d2", status: "refused" },
      ],
    });
    expect(machineListLines(golden)).toEqual([
      "studio  Studio Mac  online                 operate",
      "pi                  doesn't let agents in",
    ]);
  });

  test("no links says where to add one", () => {
    expect(machineListLines({ machines: [] })[0]).toMatch(/Fleet page/);
  });
});

describe("device list", () => {
  const device = (id: string, extra: object) => ({
    id,
    name: `Device ${id}`,
    scopes: ["read"],
    createdAt: now - 10 * day,
    lastSeenAt: now - 2 * hour,
    revokedAt: null,
    ...extra,
  });
  const golden = cliOutputs["device.list"].parse([
    device("d1", {}),
    device("d2", { expiresAt: now + 3 * day }),
    device("d3", { revokedAt: now - day }),
  ]);

  test("live devices with when they were seen and when access ends; revoked ones counted", () => {
    expect(deviceListLines(golden, now)).toEqual([
      "d1  Device d1  seen 2h ago",
      "d2  Device d2  seen 2h ago  access ends in 3d",
      "",
      "1 revoked. Their records stay; --json lists them.",
    ]);
  });

  test("--quiet prints only devices that still have access", () => {
    expect(deviceIds(golden)).toEqual(["d1", "d2"]);
  });
});

test("the remote in use is marked, local included", () => {
  const golden = cliOutputs["remote.list"].parse({
    active: "studio",
    profiles: [
      {
        id: "p1",
        name: "studio",
        origin: "https://studio.ts.net/",
        fingerprint: "f",
        deviceId: "d",
      },
    ],
  });
  expect(remoteListLines(golden)).toEqual([
    "   local   this machine",
    "*  studio  https://studio.ts.net/",
  ]);
});

describe("mcp", () => {
  const grant = (id: string, extra: object) => ({
    id,
    clientKind: "cli",
    clientId: id,
    name: `Client ${id}`,
    domain: null,
    scopes: ["threads:read", "threads:start"],
    projects: "all",
    createdAt: now - day,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    approvedBy: "local",
    started: [],
    messaged: [],
    ...extra,
  });
  const golden = cliOutputs["mcp.list"].parse({
    url: "http://127.0.0.1:4000/mcp",
    grants: [
      grant("g1", { lastUsedAt: now - hour }),
      grant("g2", { expiresAt: now + 2 * day }),
      grant("g3", { revokedAt: now - hour }),
    ],
  });

  test("live grants with their scopes, lifetime and last use; ended ones counted", () => {
    expect(mcpListLines(golden, now)).toEqual([
      "Outside clients connect to http://127.0.0.1:4000/mcp",
      "",
      "g1  Client g1  read, start  until revoked  used 1h ago",
      "g2  Client g2  read, start  ends in 2d     never used",
      "",
      "1 ended. --json lists them.",
    ]);
    expect(grantIds(golden, now)).toEqual(["g1", "g2"]);
  });

  test("a sign-in request shows its match code and warns about an app on its own device", () => {
    const requests = cliOutputs["mcp.request.list"].parse({
      requests: [
        {
          requestId: "r1",
          clientName: "Cursor",
          domain: null,
          scopes: ["threads:read"],
          matchCode: "4821",
          expiresAt: now + 10 * 60_000,
          redirectKind: "this-device",
        },
      ],
    });
    const lines = mcpRequestLines(requests, now);
    expect(lines[0]).toBe("r1  Cursor  unverified  code 4821  read  ends in 10m");
    expect(lines.at(-1)).toMatch(/can't be vouched for/);
  });
});

test("a browser recording names the file it saved", () => {
  const golden = cliOutputs["browser.artifact"].parse({
    path: "/tmp/a.mp4",
    mimeType: "video/mp4",
    artifactId: "art_1",
  });
  expect(browserArtifactLine(golden)).toBe("Saved the recording to /tmp/a.mp4.");
});
