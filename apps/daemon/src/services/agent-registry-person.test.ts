import { expect, test } from "vitest";
import { DeviceId, type RegistryRequest, type RegistryResult } from "@ace/protocol";
import { reauthSentence } from "../marketplace/fresh-sign-in.ts";
import { createAgentRegistrySession } from "./agent-registry.ts";

/*
 * What runs is the person's to approve (ADR 0044): binding a command, installing an agent and
 * approving an agent's update need a socket that proved the person (ADR 0190). The host token
 * carries admin under any device id it names, and any process of the person's can read it, so
 * admin alone is not enough. Reading and refreshing the registry still need only their scopes.
 */

const digest = "a".repeat(64);
const personOnly: RegistryRequest[] = [
  {
    type: "registry.bind",
    requestId: "bind",
    acpAgentId: "local:mine",
    installationId: "mine-1",
    instanceId: "mine-1:default",
    version: "1.0.0",
    command: "/bin/true",
    args: [],
  },
  { type: "registry.install-intent", requestId: "intent", digest, intentId: "intent-1" },
  {
    type: "registry.approve-update",
    requestId: "approve",
    acpAgentId: "local:mine",
    installationId: "mine-1",
    instanceId: "mine-1:default",
    executableDigest: digest,
    previousExecutableDigest: "b".repeat(64),
    generation: 0,
  },
];

/** A registry socket for `caller`, holding every scope, over a registry that records requests. */
function session(caller: { device: string; proven: boolean }) {
  const reached: string[] = [];
  const sent: unknown[] = [];
  const tasks = new Set<Promise<void>>();
  const service = createAgentRegistrySession({
    options: {
      agentRegistry: {
        handle: async (request): Promise<RegistryResult> => {
          reached.push(request.type);
          return {
            type: "registry.result",
            requestId: request.requestId,
            result: { ok: true, cancelled: false },
          };
        },
      },
    },
    authorize: () => true,
    send: (message) => sent.push(message),
    tasks,
    device: () => DeviceId.parse(caller.device),
    connected: () => true,
    personProven: () => caller.proven,
  });
  const ask = async (request: RegistryRequest) => {
    await service.handle?.(request, DeviceId.parse(caller.device));
    await Promise.all(tasks);
    return sent.at(-1);
  };
  return { ask, reached };
}

test.each(personOnly)(
  "$type from the host token, which any of the person's processes can read, never reaches the registry",
  async (request) => {
    const { ask, reached } = session({ device: "ace-cli", proven: false });
    expect(await ask(request)).toEqual({
      type: "registry.result",
      requestId: request.requestId,
      result: { ok: false, reason: reauthSentence },
    });
    expect(reached).toEqual([]);
  },
);

test.each(personOnly)(
  "$type from a socket that proved the person goes through",
  async (request) => {
    const { ask, reached } = session({ device: "person-phone", proven: true });
    expect(await ask(request)).toMatchObject({ result: { ok: true } });
    expect(reached).toEqual([request.type]);
  },
);

test("an agent's device is refused even on a socket that proved the person", async () => {
  const { ask, reached } = session({ device: "ace-agent", proven: true });
  const [approval] = personOnly.slice(-1);
  if (!approval) throw new Error("No approval");
  expect(await ask(approval)).toMatchObject({
    result: { ok: false, reason: "Only the person can approve agents: agents can't." },
  });
  expect(reached).toEqual([]);
});

test("reading and refreshing the registry don't need the person's proof", async () => {
  const { ask, reached } = session({ device: "ace-cli", proven: false });
  await ask({ type: "registry.list", requestId: "list", offset: 0, limit: 10 });
  await ask({ type: "registry.refresh", requestId: "refresh" });
  expect(reached).toEqual(["registry.list", "registry.refresh"]);
});
