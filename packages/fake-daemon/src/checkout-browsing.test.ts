import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, ThreadId, WorkspaceId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

/** The Files and Browser tools' paths through the fake daemon, as a client reaches them. */
async function fixture() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("laptop"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `req-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  return { daemon, client };
}

test("a checkout file the thread's project holds downloads with its text, and search finds it", async () => {
  const { daemon, client } = await fixture();
  try {
    daemon.createThread({
      id: "relay-thread",
      workspaceId: "relay",
      title: "R",
      provider: "codex",
    });
    const threadId = ThreadId.parse("relay-thread");
    const completion = await client.request({
      type: "context.request",
      operation: { op: "mention.complete", threadId, query: "outbox", limit: 10 },
    });
    expect(completion.result).toEqual({
      kind: "completion",
      paths: ["apps/web/src/relay/outbox.ts"],
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of client.downloadFile({
      threadId,
      op: "download",
      path: "apps/web/src/relay/outbox.ts",
      offset: 0,
    }))
      chunks.push(chunk);
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    expect(text).toContain("export class Outbox");
    const missing = await client.request({
      type: "files.request",
      threadId,
      operation: { op: "stat", path: "apps/web/src/nope.ts" },
    });
    expect(missing).toMatchObject({ value: { version: null } });
  } finally {
    await client.close();
  }
});

test("a person's navigation needs control, and a local port nothing listens on fails like Chromium", async () => {
  const { daemon, client } = await fixture();
  try {
    daemon.createThread({ id: "web", workspaceId: "ace", title: "W", provider: "codex" });
    const threadId = ThreadId.parse("web");
    await client.request({
      type: "browser.open",
      options: { threadId, workspaceId: WorkspaceId.parse("ace") },
    });
    const navigate = (url: string) =>
      client.request({
        type: "browser.execute",
        threadId,
        command: { action: "navigate", url },
      });
    expect(await navigate("https://example.com")).toMatchObject({
      ok: false,
      error: "Browser controller mismatch",
    });
    await client.request({ type: "browser.takeover", threadId });
    expect(await navigate("https://example.com/docs")).toMatchObject({
      ok: true,
      result: { url: "https://example.com/docs", controller: "human" },
    });
    expect(await navigate("http://localhost:4321/")).toMatchObject({
      ok: false,
      error: "net::ERR_CONNECTION_REFUSED at http://localhost:4321/",
    });
    expect(await navigate("http://localhost:1/")).toMatchObject({
      ok: false,
      error: "net::ERR_UNSAFE_PORT at http://localhost:1/",
    });
  } finally {
    await client.close();
  }
});
