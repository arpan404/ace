import { mkdir, writeFile, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { CommandLibrary } from "@ace/commands";
import { ThreadId } from "@ace/protocol";
import { fixture } from "./socket-test-support.ts";
import { setup } from "./remote-test-support.ts";

async function library() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-library-wire-")));
  await mkdir(join(home, "ace/prompts"), { recursive: true });
  await writeFile(
    join(home, "ace/prompts/explain.md"),
    "---\nname: explain\narguments:\n  file: {type: string, required: true}\n---\nExplain {{file}}",
  );
  const service = new CommandLibrary({
    aceHome: join(home, "ace"),
    instances: [{ id: "codex", provider: "codex", home: join(home, "codex") }],
    now: () => 0,
    context(thread) {
      if (thread === "unknown") throw new Error("Unknown thread");
      return { workspace: home, provider: "codex", instance: "codex" };
    },
  });
  return {
    service,
    async close() {
      await service.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
it("lists and resolves snippets over authenticated WebSocket without executing provider commands", async () => {
  const lib = await library(),
    f = await fixture({ commands: lib.service });
  try {
    const client = await f.connect();
    expect((await client.next()).type).toBe("welcome");
    client.send({
      type: "commands.list",
      requestId: "list",
      threadId: f.thread.id,
      query: "exp",
      limit: 20,
    });
    const result = await client.next();
    expect(result.type).toBe("commands.list.result");
    if (result.type !== "commands.list.result") throw new Error("Wrong message");
    const command = result.commands[0];
    if (!command) throw new Error("Missing snippet");
    expect(command.name).toBe("explain");
    expect(JSON.stringify(result)).not.toContain("Explain {{file}}");
    const seq = f.store.headSeq();
    client.send({
      type: "commands.resolve",
      requestId: "resolve",
      threadId: f.thread.id,
      commandId: command.id,
      arguments: { file: "app.ts" },
      positional: [],
    });
    expect(await client.next()).toEqual({
      type: "commands.resolve.result",
      requestId: "resolve",
      result: { ok: true, plan: { kind: "prompt", provider: "codex", text: "Explain app.ts" } },
    });
    expect(f.store.headSeq()).toBe(seq);
    client.send({
      type: "commands.resolve",
      requestId: "missing",
      threadId: f.thread.id,
      commandId: command.id,
      arguments: {},
      positional: [],
    });
    expect(await client.next()).toMatchObject({
      type: "commands.resolve.result",
      result: { ok: false, error: "missing_argument", argument: "file" },
    });
    client.send({
      type: "commands.list",
      requestId: "bad",
      threadId: ThreadId.parse("unknown"),
      query: "",
      limit: 20,
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "read_denied" });
  } finally {
    await f.close();
    await lib.close();
  }
});
it("allows read-scoped remote previews and rejects devices without read scope", async () => {
  const lib = await library(),
    f = await setup({ commands: lib.service });
  try {
    const reader = await f.pair(["read"]),
      readerTicket = await f.ticket(reader.token),
      client = await f.connectTicket(reader.device.id, readerTicket.ticket);
    expect((await client.next()).type).toBe("welcome");
    client.send({
      type: "commands.list",
      requestId: "list",
      threadId: f.thread.id,
      query: "explain",
      limit: 20,
    });
    const list = await client.next();
    if (list.type !== "commands.list.result") throw new Error("Missing catalog");
    const command = list.commands[0];
    if (!command) throw new Error("Missing snippet");
    client.send({
      type: "commands.resolve",
      requestId: "resolve",
      threadId: f.thread.id,
      commandId: command.id,
      arguments: { file: "x" },
      positional: [],
    });
    expect(await client.next()).toMatchObject({
      type: "commands.resolve.result",
      result: { ok: true, plan: { text: "Explain x" } },
    });
    const operator = await f.pair(["operate"]),
      issued = await f.ticket(operator.token),
      blocked = await f.connectTicket(operator.device.id, issued.ticket);
    expect((await blocked.next()).type).toBe("welcome");
    blocked.send({
      type: "commands.list",
      requestId: "forbidden",
      threadId: f.thread.id,
      query: "",
      limit: 20,
    });
    expect(await blocked.next()).toMatchObject({ type: "error", code: "forbidden" });
  } finally {
    await lib.close();
  }
});

it("denies list and resolution when the thread access policy rejects the device", async () => {
  const lib = await library(),
    f = await fixture({ commands: lib.service, canReadThread: () => false });
  try {
    const client = await f.connect();
    await client.next();
    client.send({
      type: "commands.list",
      requestId: "list",
      threadId: f.thread.id,
      query: "",
      limit: 10,
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "read_denied" });
    client.send({
      type: "commands.resolve",
      requestId: "resolve",
      threadId: f.thread.id,
      commandId: "ace#fork",
      arguments: {},
      positional: [],
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "read_denied" });
  } finally {
    await f.close();
    await lib.close();
  }
});
