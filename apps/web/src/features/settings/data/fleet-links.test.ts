import { DeviceId, HostId, type Device, type FleetLink } from "@ace/protocol";
import { expect, test } from "vitest";
import { fleetDevices, linkDeviceIds, linkGaps, reach, unlinkedWith } from "./fleet-links.ts";

function link(to: string, extra: Partial<FleetLink> = {}): FleetLink {
  return {
    hostId: HostId.parse(to),
    profile: to,
    name: to,
    origin: `https://${to}.local:5870/`,
    deviceId: DeviceId.parse(`dev-${to}`),
    status: "online",
    access: "operate",
    ...extra,
  };
}

function device(id: string, name: string, extra: Partial<Device> = {}): Device {
  return {
    id: DeviceId.parse(id),
    name,
    scopes: ["read", "operate"],
    createdAt: 1,
    lastSeenAt: 10,
    revokedAt: null,
    ...extra,
  };
}

test("every unlinked direction between online machines is a gap, and offline ones are left out", () => {
  const gaps = linkGaps([
    { id: "mac", name: "Mac", online: true, links: [link("studio")] },
    { id: "studio", name: "Studio", online: true, links: [] },
    { id: "imac", name: "iMac", online: false, links: undefined },
  ]);
  expect(gaps).toEqual([{ from: "studio", to: "mac" }]);
  expect(unlinkedWith("mac", gaps)).toEqual(["studio"]);
  expect(unlinkedWith("imac", gaps)).toEqual([]);
});

test("a machine whose links can't be read offers no Link button for it", () => {
  const gaps = linkGaps([
    { id: "mac", name: "Mac", online: true, links: undefined },
    { id: "studio", name: "Studio", online: true, links: [link("mac")] },
  ]);
  expect(gaps).toEqual([]);
});

test("a link to a machine that lets no agents in reads as closed, not linked", () => {
  const studio = { id: "studio", name: "Studio", online: true, links: [] };
  expect(
    reach(
      { id: "mac", name: "Mac", online: true, links: [link("studio", { status: "refused" })] },
      studio,
    ),
  ).toEqual({ kind: "closed" });
  expect(
    reach(
      { id: "mac", name: "Mac", online: true, links: [link("studio", { access: "read" })] },
      studio,
    ),
  ).toEqual({ kind: "linked", access: "read" });
});

test("the same phone on two machines is one device, and machine links are not devices", () => {
  const facts = [
    {
      id: "mac",
      name: "Mac",
      online: true,
      links: [link("studio", { deviceId: DeviceId.parse("mac-on-studio") })],
    },
    { id: "studio", name: "Studio", online: true, links: [] },
  ];
  const joined = fleetDevices(
    new Map([
      ["mac", [device("p1", "iPhone", { lastSeenAt: 50, expiresAt: 900 })]],
      [
        "studio",
        [
          device("p2", "iPhone", { lastSeenAt: 70, expiresAt: 400 }),
          device("mac-on-studio", "Mac"),
          device("i1", "iPad", { lastSeenAt: 20 }),
        ],
      ],
    ]),
    linkDeviceIds(facts),
  );
  expect(joined.map((entry) => entry.name)).toEqual(["iPhone", "iPad"]);
  expect(joined[0]?.on.map((entry) => entry.machine)).toEqual(["mac", "studio"]);
  expect(joined[0]?.lastSeenAt).toBe(70);
  // It loses access on the first machine that expires it.
  expect(joined[0]?.expiresAt).toBe(400);
  expect(joined[1]?.expiresAt).toBeNull();
});
