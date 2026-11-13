import { expect, test } from "vitest";
import {
  ClientMessage,
  DeviceId,
  ServerMessage,
  WorkspaceId,
  ThreadId,
  AgentId,
  type DeviceScope,
} from "@ace/protocol";
import type { z } from "zod";
import { SpadeComputers } from "../spade/computers.ts";
import { createSpadeComputerSession } from "./spade-computer.ts";

/** Spade's socket to the daemon, with bots whose computers never opened a browser. */
function socket(scopes: readonly DeviceScope[] = ["read", "operate"]) {
  const computers = new SpadeComputers({
    host: () => ({
      threadId: ThreadId.parse("spade-host"),
      agentId: AgentId.parse("root"),
      workspaceId: WorkspaceId.parse("spade"),
    }),
    find: () => undefined,
    create: () => undefined,
    tabs: () => [],
    apps: () => [],
    now: () => 5_000,
  });
  const sent: ServerMessage[] = [];
  const session = createSpadeComputerSession({
    options: { spadeComputers: computers },
    authorize: (scope) => scopes.includes(scope),
    connected: () => true,
    send: (message) => sent.push(ServerMessage.parse(message)),
  });
  return async (message: z.input<typeof ClientMessage>) => {
    await session.handle?.(ClientMessage.parse(message), DeviceId.parse("spade"));
    return sent.at(-1);
  };
}

test("Spade reads a bot's computer and takes it over and back over its socket", async () => {
  const ask = socket();
  expect(await ask({ type: "spade.computer.get", requestId: "g", bot: "fares" })).toEqual({
    type: "spade.computer.result",
    requestId: "g",
    computer: { bot: "fares", driver: "bot", browser: { tabs: [] }, screen: { apps: [] } },
  });
  expect(
    await ask({ type: "spade.computer.drive", requestId: "d", bot: "fares", driver: "person" }),
  ).toEqual({ type: "spade.computer.drive.result", requestId: "d", driver: "person" });
  expect(
    await ask({ type: "spade.computer.drive", requestId: "b", bot: "fares", driver: "bot" }),
  ).toEqual({
    type: "spade.computer.drive.result",
    requestId: "b",
    driver: "bot",
    handback: { drivenMs: 0, visited: [], opened: [], closed: [], screenUsed: false },
  });
});

test("a device without operate can neither read a bot's computer nor take it over", async () => {
  const ask = socket(["read"]);
  expect(await ask({ type: "spade.computer.get", requestId: "g", bot: "fares" })).toEqual({
    type: "spade.computer.result",
    requestId: "g",
    error: "forbidden",
  });
  expect(
    await ask({ type: "spade.computer.drive", requestId: "d", bot: "fares", driver: "person" }),
  ).toEqual({ type: "spade.computer.drive.result", requestId: "d", error: "forbidden" });
});
