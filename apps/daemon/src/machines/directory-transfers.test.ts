import { expect, test } from "vitest";
import { HostId, MachineCallOrigin, type MachineDescription } from "@ace/protocol";
import { RemoteProfile } from "../cli/profiles.ts";
import { MachineDirectory } from "./directory.ts";

const origin = MachineCallOrigin.parse({
  hostId: "host-here",
  hostName: "Laptop",
  threadId: "parent",
  threadTitle: "Parent",
});
const description: MachineDescription = {
  hostId: HostId.parse("host-studio"),
  name: "Studio",
  access: "operate",
  projects: [],
  tools: [],
  providers: [],
  transfers: true,
};

test("agents see that a machine linked through a relay only takes transfers", async () => {
  const relayOnly = RemoteProfile.parse({
    id: "00000000-0000-4000-8000-000000000002",
    name: "studio",
    relay: { url: "wss://relay.example.com", relayHostId: "A".repeat(52) },
    deviceId: "device-studio",
    token: "b".repeat(64),
  });
  const machines = new MachineDirectory({
    profiles: () => [relayOnly],
    transport: async () => description,
    log: () => {},
  });
  expect(await machines.list(origin)).toMatchObject([{ machine: "studio", transfers: true }]);
});
