import { existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DeviceId, Thread, ThreadId, type ClientMessage } from "@ace/protocol";
import { writingFixture, writingThreadId } from "./source-control-test-support.ts";
import { startServer } from "./server.ts";
import { stubHandler } from "./commands.ts";
import { Client, token } from "./socket-test-support.ts";
import { setup, cleanups } from "./remote-test-support.ts";

function receivedPrompt(root: string) {
  return new Promise<void>((resolve) => {
    const path = join(root, "prompt.txt");
    const watcher = watch(root, () => {
      if (existsSync(path)) {
        watcher.close();
        resolve();
      }
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

const cancel = (threadId = writingThreadId): ClientMessage => ({
  type: "workspace.request",
  requestId: "cancel",
  operation: {
    op: "git.draft.cancel",
    threadId,
    generationId: "owned-generation",
  },
});

test("a CLI exceeding the output limit is refused without changing Git", async () => {
  const f = await writingFixture("claude", "overflow");
  try {
    await expect(f.generate()).rejects.toThrow("draft_provider_failed");
    expect(f.git("rev-parse", "HEAD")).toBe(f.initialHead);
    expect(f.git("diff", "--cached", "--name-only")).toBe("excluded.txt");
  } finally {
    await f.close();
  }
}, 60000);

test("the generation deadline stops a waiting CLI and leaves selected files untouched", async () => {
  let expire: (() => void) | undefined;
  const f = await writingFixture("claude", "wait", {
    clock: {
      now: () => 1,
      setTimer: (callback) => {
        expire = callback;
        return () => {};
      },
    },
  });
  try {
    const received = receivedPrompt(f.root);
    const generation = f.generate();
    await received;
    if (!expire) throw new Error("Generation deadline not armed");
    expire();
    await expect(generation).rejects.toThrow("draft_timeout");
    expect(f.git("diff", "--name-only")).toBe("selected.txt");
    expect(f.git("diff", "--cached", "--name-only")).toBe("excluded.txt");
  } finally {
    await f.close();
  }
}, 60000);

async function socketFixture(behavior: string) {
  const f = await writingFixture("claude", behavior);
  const other = ThreadId.parse("other-thread");
  f.store.appendEvents(other, [
    {
      type: "thread.created",
      thread: Thread.parse({
        id: other,
        workspaceId: f.workspaceId,
        title: "Other thread",
        provider: "claude",
        status: { state: "new" },
        createdAt: 1,
        updatedAt: 1,
      }),
    },
  ]);
  const server = await startServer({
    port: 0,
    token,
    hostId: "test-host",
    store: f.store,
    handler: stubHandler({ development: true }),
    workspaceActions: f.runtime,
  });
  const clients: Client[] = [];
  const connect = async (id: string) => {
    const client = new Client(server.url);
    clients.push(client);
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse(id), token });
    await client.next();
    return client;
  };
  const context = await f.context();
  const generation: ClientMessage = {
    type: "workspace.request",
    requestId: "generate",
    operation: {
      op: "git.draft.generate",
      threadId: writingThreadId,
      input: {
        generationId: "owned-generation",
        selection: f.selection,
        fingerprint: context.fingerprint,
        provider: "claude",
        preference: "",
      },
    },
  };
  return {
    ...f,
    other,
    connect,
    generation,
    cancel,
    async close() {
      for (const client of clients) await client.close();
      await server.close();
      await f.close();
    },
  };
}

test("another socket or thread cannot cancel the owner's generation", async () => {
  const f = await socketFixture("hold");
  try {
    const owner = await f.connect("owner");
    const stranger = await f.connect("stranger");
    const received = receivedPrompt(f.root);
    owner.send(f.generation);
    await received;
    stranger.send(f.cancel());
    expect(await stranger.next()).toMatchObject({
      type: "workspace.result",
      requestId: "cancel",
      result: { kind: "draftCancelled" },
    });
    owner.send(f.cancel(f.other));
    expect(await owner.next()).toMatchObject({
      type: "workspace.result",
      requestId: "cancel",
      result: { kind: "draftCancelled" },
    });
    await writeFile(join(f.root, "release"), "");
    expect(await owner.next()).toMatchObject({
      type: "workspace.result",
      requestId: "generate",
      result: {
        kind: "draft",
        draft: { subject: "fix: update selected behavior" },
      },
    });
  } finally {
    await f.close();
  }
}, 60000);

test("the owning socket can cancel its CLI while the generation request is pending", async () => {
  const f = await socketFixture("wait");
  try {
    const owner = await f.connect("owner");
    const received = receivedPrompt(f.root);
    owner.send(f.generation);
    await received;
    owner.send(f.cancel());
    expect([await owner.next(), await owner.next()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: "cancel", result: { kind: "draftCancelled" } }),
        expect.objectContaining({
          requestId: "generate",
          result: { kind: "error", code: "draft_cancelled" },
        }),
      ]),
    );
    expect(f.git("rev-parse", "HEAD")).toBe(f.initialHead);
  } finally {
    await f.close();
  }
}, 60000);

test("a paired read-only socket can inspect source context but cannot generate or cancel drafts", async () => {
  const f = await writingFixture();
  cleanups.push(() => f.close());
  const remote = await setup({
    workspaceActions: f.runtime,
    canReadThread: (_device, id) => id === writingThreadId,
  });
  const paired = await remote.pair(["read"]);
  const ticket = await remote.ticket(paired.token);
  const reader = await remote.connectTicket(paired.device.id, ticket.ticket);
  await reader.next();
  reader.send({
    type: "workspace.request",
    requestId: "context",
    operation: {
      op: "git.draft.context",
      threadId: writingThreadId,
      selection: f.selection,
    },
  });
  expect(await reader.next()).toMatchObject({
    type: "workspace.result",
    requestId: "context",
    result: { kind: "draftContext", context: { paths: ["selected.txt"] } },
  });
  reader.send({
    type: "workspace.request",
    requestId: "generate",
    operation: {
      op: "git.draft.generate",
      threadId: writingThreadId,
      input: {
        generationId: "forbidden",
        selection: f.selection,
        fingerprint: (await f.context()).fingerprint,
        provider: "claude",
        preference: "",
      },
    },
  });
  expect(await reader.next()).toMatchObject({
    type: "workspace.result",
    requestId: "generate",
    result: { kind: "error", code: "forbidden" },
  });
  reader.send({
    type: "workspace.request",
    requestId: "cancel",
    operation: {
      op: "git.draft.cancel",
      threadId: writingThreadId,
      generationId: "forbidden",
    },
  });
  expect(await reader.next()).toMatchObject({
    type: "workspace.result",
    requestId: "cancel",
    result: { kind: "error", code: "forbidden" },
  });
  expect(existsSync(join(f.root, "prompt.txt"))).toBe(false);
}, 60000);
