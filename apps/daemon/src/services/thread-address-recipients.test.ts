import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentId, CommandId, DeviceId, type Command, type ServerMessage } from "@ace/protocol";
import { createDevThread } from "../commands.ts";
import { Store } from "../store.ts";
import { ThreadAskStore } from "../thread-address/asks-store.ts";
import { ThreadAsks } from "../thread-address/asks.ts";
import type { SocketContext } from "./socket.ts";
import { createThreadAddressSession } from "./thread-address.ts";

// ADR 0209 §5.2, §6.1: only a tree's owner writes into it. Reading a colleague's tree is not
// writing into it, so a message addressed to the agent of a tree the sender may only read is
// refused, and never steers that agent.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("a message reaches only the agents whose trees the sender may write into", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-address-"));
  homes.push(home);
  const store = new Store(join(home, "events.sqlite"));
  const workspace = store.createWorkspace(join(home, "repo"), "Repo");
  const mine = createDevThread(store, workspace);
  const colleagues = createDevThread(store, workspace);
  const device = DeviceId.parse("phone");
  const handled: Command[] = [];
  const sent: ServerMessage[] = [];
  const asks = new ThreadAsks({
    store: new ThreadAskStore(store),
    spade: () => undefined,
    call: async () => ({ kind: "unreachable" }) as never,
    sign: () => undefined,
    post: () => {},
    hold: () => {},
    waiting: () => {},
    title: () => "Thread",
    now: () => 1,
    sleep: async () => {},
    log: () => {},
  });
  const session = createThreadAddressSession({
    options: {
      store,
      threadAsks: asks,
      engine: { rootAgent: () => AgentId.parse("a_root"), prepareCommand: async () => {} },
      handler: {
        handle: (command: Command) => {
          handled.push(command);
          return { commandId: command.id, ok: true };
        },
      },
    },
    send: (message: ServerMessage) => sent.push(message),
    canReadThread: () => true,
    // The sender owns their own tree and may only read their colleague's.
    canWriteThread: (thread: string) => thread === mine.id,
  } as unknown as SocketContext);
  const command: Command = {
    id: CommandId.parse("cmd_ask"),
    deviceId: device,
    payload: {
      type: "thread.address",
      threadId: mine.id,
      about: "the colleague's agent",
      input: [{ type: "text", text: "Delete the branch." }],
      to: [{ kind: "agent", threadId: colleagues.id, title: "Their agent" }],
      devices: [],
      share: "message",
      files: [],
    },
  };
  await session.command?.accept(command, device);
  expect(handled.filter((each) => each.payload.type === "thread.send")).toEqual([]);
  expect(sent).toContainEqual(
    expect.objectContaining({ type: "commandResult", ok: false, error: "forbidden" }),
  );
  store.close();
});
