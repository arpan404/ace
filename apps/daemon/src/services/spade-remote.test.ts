import { expect, test } from "vitest";
import {
  DeviceId,
  HostId,
  ServerMessage,
  ThreadId,
  type DeviceScope,
  type MachineCallRequest,
} from "@ace/protocol";
import { ClientMessage as ClientMessages } from "@ace/protocol";
import type { z } from "zod";
import { RemoteProfile } from "../cli/profiles.ts";
import { MachineDirectory } from "../machines/directory.ts";
import { MachineFailure, type MachineTransport } from "../machines/transport.ts";
import { SpadeRemote } from "../spade/remote.ts";
import { createSpadeRemoteSession } from "./spade-remote.ts";

const profile = (name: string, hostId: string, n: number) =>
  RemoteProfile.parse({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name,
    origin: `https://${name}.local:7443/`,
    fingerprint: "a".repeat(64),
    deviceId: `device-${n}`,
    token: String(n).repeat(64),
    hostId,
  });
const desk = profile("desk", "desk-host", 1);
const studio = profile("studio", "studio-host", 2);

/**
 * Spade's socket on this daemon, with two linked machines: `desk` answers the way `answer`
 * says, `studio` is asleep. Calls go out through a transport standing in for the network.
 */
function daemon(input: {
  answer: (body: MachineCallRequest) => unknown;
  scopes?: readonly DeviceScope[];
}) {
  const calls: MachineCallRequest[] = [];
  const transport: MachineTransport = async (target, body) => {
    calls.push(body);
    if (target.name === "studio") throw new MachineFailure("offline");
    return input.answer(body);
  };
  const directory = new MachineDirectory({
    profiles: () => [desk, studio],
    transport,
    log: () => {},
  });
  const remote = new SpadeRemote({
    directory,
    origin: async () => ({
      hostId: HostId.parse("laptop-host"),
      hostName: "Laptop",
      threadId: ThreadId.parse("spade-host-thread"),
      threadTitle: "Spade",
      ceiling: "operate",
    }),
  });
  const sent: ServerMessage[] = [];
  const tasks = new Set<Promise<void>>();
  const session = createSpadeRemoteSession({
    options: { spadeRemote: remote },
    authorize: (scope) => (input.scopes ?? ["read", "operate"]).includes(scope),
    connected: () => true,
    send: (message) => sent.push(ServerMessage.parse(message)),
    tasks,
  });
  const ask = async (message: z.input<typeof ClientMessages>) => {
    await session.handle?.(ClientMessages.parse(message), DeviceId.parse("spade"));
    await Promise.all(tasks);
    return sent.at(-1);
  };
  return { ask, calls };
}

const describeDesk = {
  hostId: "desk-host",
  name: "Desk",
  access: "operate",
  projects: [],
  tools: ["agents"],
  providers: [],
};

test("a request reaches the machine with that host id and brings back its Spade's answer", async () => {
  const { ask, calls } = daemon({ answer: () => ({ status: 200, body: { bots: [] } }) });
  expect(
    await ask({
      type: "spade.remote",
      requestId: "r",
      machine: "desk-host",
      request: { op: "bots" },
    }),
  ).toEqual({
    type: "spade.remote.result",
    requestId: "r",
    result: { kind: "response", status: 200, body: { bots: [] } },
  });
  expect(calls).toEqual([
    expect.objectContaining({
      call: { op: "spade", request: { op: "bots" } },
      origin: expect.objectContaining({ hostId: "laptop-host", threadId: "spade-host-thread" }),
    }),
  ]);
});

test("a host id no linked machine has is unknown_machine, and nothing is sent", async () => {
  const { ask, calls } = daemon({ answer: () => ({ status: 200, body: {} }) });
  expect(
    await ask({
      type: "spade.remote",
      requestId: "r",
      machine: "elsewhere",
      request: { op: "bots" },
    }),
  ).toMatchObject({ result: { kind: "error", code: "unknown_machine" } });
  expect(calls).toEqual([]);
});

test("a machine that can't be reached is offline", async () => {
  const { ask } = daemon({ answer: () => ({ status: 200, body: {} }) });
  expect(
    await ask({
      type: "spade.remote",
      requestId: "r",
      machine: "studio-host",
      request: { op: "ask", key: "laptop-host.1", to: "b", text: "Hi", depth: 1 },
    }),
  ).toMatchObject({ result: { kind: "error", code: "offline" } });
});

test("a connection lost after sending is disconnected; a machine saying no is refused", async () => {
  for (const [failure, code] of [
    [new MachineFailure("disconnected"), "disconnected"],
    [new MachineFailure("refused", "machine_forbidden", "Agents may only read here."), "refused"],
    [
      new MachineFailure("refused", "unavailable", "Spade isn't running on this machine."),
      "refused",
    ],
  ] as const) {
    const { ask } = daemon({
      answer: () => {
        throw failure;
      },
    });
    const reply = await ask({
      type: "spade.remote",
      requestId: "r",
      machine: "desk-host",
      request: { op: "stop", key: "k" },
    });
    expect(reply).toMatchObject({ result: { kind: "error", code } });
    if (failure.refusal)
      expect(reply).toMatchObject({
        result: { message: `${failure.refusal}: ${failure.message}` },
      });
  }
});

test("without operate, Spade's socket can't reach other machines", async () => {
  const { ask, calls } = daemon({ answer: () => ({ status: 200, body: {} }), scopes: ["read"] });
  expect(
    await ask({
      type: "spade.remote",
      requestId: "r",
      machine: "desk-host",
      request: { op: "bots" },
    }),
  ).toMatchObject({ result: { kind: "error", code: "forbidden" } });
  expect(await ask({ type: "spade.machines", requestId: "m" })).toEqual({
    type: "spade.machines.result",
    requestId: "m",
    machines: [],
  });
  expect(calls).toEqual([]);
});

test("the machine list has each linked machine's host id, online or offline", async () => {
  const { ask } = daemon({ answer: () => describeDesk });
  expect(await ask({ type: "spade.machines", requestId: "m" })).toEqual({
    type: "spade.machines.result",
    requestId: "m",
    machines: [
      { hostId: "desk-host", name: "Desk", status: "online" },
      { hostId: "studio-host", name: "studio", status: "offline" },
    ],
  });
});

test("a machine that refuses this one is left out of the list", async () => {
  const { ask } = daemon({
    answer: () => {
      throw new MachineFailure("refused", "machine_opted_out");
    },
  });
  expect(await ask({ type: "spade.machines", requestId: "m" })).toMatchObject({
    machines: [{ hostId: "studio-host", status: "offline" }],
  });
});
