import { expect, test } from "vitest";
import { Command, DeviceId, ServerMessage, type ClientMessage } from "@ace/protocol";
import { FakeDaemon } from "./daemon.ts";

/** A daemon whose worktree creations wait for `finish()`, so one can be seen still running. */
function fixture() {
  const jobs: (() => void)[] = [];
  const daemon = new FakeDaemon({
    clock: () => 1000,
    worktreeCreationSlow: true,
    worktreeCreationSchedule(callback) {
      jobs.push(callback);
      return () => {};
    },
  });
  const socket = (deviceId: string) => {
    const messages: ServerMessage[] = [];
    const connection = daemon.connect({
      send: (text) => messages.push(ServerMessage.parse(JSON.parse(text))),
      close() {},
    });
    const send = (message: ClientMessage) => connection.receive(JSON.stringify(message));
    send({
      type: "hello",
      deviceId: DeviceId.parse(deviceId),
      token: "fake-token",
      protocolVersion: 1,
    });
    messages.length = 0;
    const ask = (...commandIds: string[]) => {
      const from = messages.length;
      send({
        type: "command.status",
        requestId: `ask-${from}`,
        commandIds: commandIds.map((id) => Command.shape.id.parse(id)),
      });
      return messages.slice(from);
    };
    return { messages, send, ask };
  };
  const finish = async () => {
    while (jobs.length) jobs.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { socket, finish };
}

const create = Command.parse({
  id: "create",
  deviceId: "phone",
  payload: {
    type: "thread.create",
    threadId: "tree",
    workspaceId: "project",
    provider: "codex",
    mode: "worktree",
    base: { remote: "origin", ref: "main" },
    input: [{ type: "text", text: "First message" }],
  },
});
const archive = Command.parse({
  id: "archive",
  deviceId: "phone",
  payload: { type: "thread.archive", threadId: "missing" },
});

test("a reconnected device learns which commands are running, settled or unknown", () => {
  const f = fixture();
  const first = f.socket("phone");
  first.send({ type: "command", command: create });
  first.send({ type: "command", command: archive });
  const archived = first.messages.find(
    (message) => message.type === "commandResult" && message.commandId === "archive",
  );
  expect(archived).toBeDefined();

  const again = f.socket("phone");
  expect(again.ask("create", "archive", "never-sent")).toEqual([
    archived,
    {
      type: "command.status",
      requestId: "ask-0",
      commands: [
        { commandId: "create", state: "running" },
        { commandId: "archive", state: "settled" },
        { commandId: "never-sent", state: "unknown" },
      ],
    },
  ]);
});

test("a creation that finished is settled and its result sent again", async () => {
  const f = fixture();
  const first = f.socket("phone");
  first.send({ type: "command", command: create });
  await f.finish();
  const created = first.messages.find(
    (message) => message.type === "commandResult" && message.commandId === "create",
  );
  expect(created).toMatchObject({ ok: true });

  const reply = f.socket("phone").ask("create");
  expect(reply[0]).toEqual(created);
  expect(reply[1]).toMatchObject({ commands: [{ commandId: "create", state: "settled" }] });
});

test("another device's commands are unknown to the asker", () => {
  const f = fixture();
  const phone = f.socket("phone");
  phone.send({ type: "command", command: create });
  phone.send({ type: "command", command: archive });
  expect(f.socket("laptop").ask("create", "archive")).toEqual([
    {
      type: "command.status",
      requestId: "ask-0",
      commands: [
        { commandId: "create", state: "unknown" },
        { commandId: "archive", state: "unknown" },
      ],
    },
  ]);
});
