import { Client, type RequestOptions } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { readWhole, readTextPrefix } from "./attachment-content.ts";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.restoreAllMocks();
});
function fixture() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const client = new Client({
    deviceId: DeviceId.parse("reader"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => "read",
  });
  clients.push(client);
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const reads: { thread: string; signal?: AbortSignal }[] = [];
  vi.spyOn(client, "downloadFile").mockImplementation(async function* (
    input,
    options: RequestOptions = {},
  ) {
    if (!input.threadId) throw new Error("Missing thread scope");
    reads.push({ thread: input.threadId, ...(options.signal ? { signal: options.signal } : {}) });
    started.resolve();
    await gate.promise;
    yield new Uint8Array([1, 2, 3]);
  });
  return { client, gate, started, reads };
}
const source = {
  kind: "artifact",
  threadId: "thread",
  artifactId: "browser-image",
  bytes: 3,
} as const;

test("inline and dialog reads share bytes and closing one keeps the other alive", async () => {
  const f = fixture();
  const left = new AbortController(),
    right = new AbortController();
  const inline = readWhole(f.client, source, "image/png", left.signal);
  const preview = readWhole(f.client, source, undefined, right.signal);
  await f.started.promise;
  left.abort();
  await expect(inline).rejects.toThrow("cancelled");
  expect(f.reads[0]?.signal?.aborted).toBe(false);
  f.gate.resolve();
  const blob = await preview;
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(f.reads).toHaveLength(1);
  const reopened = await readWhole(f.client, source, "image/png", new AbortController().signal);
  expect(reopened.type).toBe("image/png");
  expect([...new Uint8Array(await reopened.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(f.reads).toHaveLength(1);
});
test("same artifact identifier stays scoped to the client and thread", async () => {
  const a = fixture(),
    b = fixture();
  const pending = [
    readWhole(a.client, source, undefined, new AbortController().signal),
    readWhole(a.client, { ...source, threadId: "other" }, undefined, new AbortController().signal),
    readWhole(b.client, source, undefined, new AbortController().signal),
  ];
  a.gate.resolve();
  b.gate.resolve();
  await Promise.all(pending);
  expect(a.reads.map((read) => read.thread)).toEqual(["thread", "other"]);
  expect(b.reads.map((read) => read.thread)).toEqual(["thread"]);
});
test("text artifact preview stops its stream after one bounded prefix", async () => {
  const f = fixture();
  let stopped = false;
  vi.spyOn(f.client, "downloadFile").mockImplementation(async function* () {
    try {
      yield new TextEncoder().encode("x".repeat(65536));
      throw new Error("Preview must not fetch the rest of this file");
    } finally {
      stopped = true;
    }
  });
  const prefix = await readTextPrefix(
    f.client,
    { ...source, bytes: 128 * 1024 },
    new AbortController().signal,
  );
  expect(prefix.text).toHaveLength(65536);
  expect(prefix.truncated).toBe(true);
  expect(stopped).toBe(true);
});

test("a cached image opens while the entire transfer budget is occupied", async () => {
  const f = fixture();
  f.gate.resolve();
  await readWhole(f.client, source, "image/png", new AbortController().signal);
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  vi.spyOn(f.client, "downloadFile").mockImplementation(async function* () {
    started.resolve();
    await held.promise;
    yield new Uint8Array([1]);
  });
  const abort = new AbortController();
  const transfer = readWhole(
    f.client,
    { ...source, artifactId: "large-video", bytes: 64 * 1024 * 1024 },
    undefined,
    abort.signal,
  );
  const failure = expect(transfer).rejects.toThrow("cancelled");
  await started.promise;
  const cached = await readWhole(f.client, source, "image/png", new AbortController().signal);
  expect([...new Uint8Array(await cached.arrayBuffer())]).toEqual([1, 2, 3]);
  abort.abort();
  await failure;
  held.resolve();
});
