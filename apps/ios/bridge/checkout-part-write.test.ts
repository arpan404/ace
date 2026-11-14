import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore, downloadFile } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId, ThreadId } from "@ace/protocol";
import { CheckoutFiles } from "./checkout-files.ts";
import { NativeFilesRequest } from "./checkout-request.ts";
import { partPieces } from "./checkout-part-write.ts";

/*
 * Editing a file too large to edit whole, a part at a time: the phone reads one part, saves its
 * new text, and the file comes out as the old bytes around the new part, never overwriting a
 * version the part wasn't read at. Real SDK, in-process fake daemon.
 */

const thread = "ios-parts";
const path = "data/events.log";
let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

/** About 1.5 MB of numbered lines: over the whole-file edit limit. */
const big = Array.from({ length: 30_000 }, (_, line) => `event ${line} ${"x".repeat(40)}`).join(
  "\n",
);

async function connect() {
  const fake = new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "t" });
  fake.createThread({ id: thread, workspaceId: "ace", title: "Parts", provider: "claude" });
  fake.apply(thread, [facts.rootAgent("claude")]);
  fake.checkouts.seedBytes(thread, path, new TextEncoder().encode(big));
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-parts-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(fake),
    credential: async () => ({ token: "t" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  void owner.start();
  await until(() => owner.state === "ready");
  const files = new CheckoutFiles(owner, async () => []);
  const ask = (operation: unknown) =>
    files.request(
      NativeFilesRequest.parse({ type: "native.files", scope: { threadId: thread }, operation }),
      new AbortController().signal,
    );
  const whole = async () => {
    const parts: Uint8Array[] = [];
    for await (const bytes of downloadFile(owner, {
      threadId: ThreadId.parse(thread),
      op: "download",
      path,
      offset: 0,
    }))
      parts.push(bytes);
    return new TextDecoder().decode(Buffer.concat(parts));
  };
  return { ask, whole };
}

test.each([
  [10, 0, 2, "ab", [{ kind: "new" }, { kind: "old", from: 2, to: 10 }]],
  [
    10,
    4,
    3,
    "",
    [
      { kind: "old", from: 0, to: 4 },
      { kind: "old", from: 7, to: 10 },
    ],
  ],
  [10, 6, 4, "z", [{ kind: "old", from: 0, to: 6 }, { kind: "new" }]],
])(
  "a %i-byte file with the part at %i (%i bytes) replaced by %j is the bytes around it and the new part",
  (size, offset, length, text, shape) => {
    const pieces = partPieces(size, offset, length, new TextEncoder().encode(text));
    expect(pieces).toMatchObject(shape);
  },
);

test("a part past the end of the file is refused", () => {
  expect(partPieces(10, 8, 4, new Uint8Array(1))).toBeNull();
});

test("a part of a file too large to edit whole saves into the file, leaving the rest as it was", async () => {
  const { ask, whole } = await connect();
  const opened = await ask({ op: "read", path });
  expect(opened).toMatchObject({ ok: true, editable: false, parts: true });
  // The second part, as the phone reads it.
  const first = await ask({ op: "page", path, offset: 0 });
  const second = await ask({ op: "page", path, offset: first.nextOffset, version: first.version });
  const length = (second.nextOffset as number) - (second.offset as number);
  const text = second.text as string;
  const edited = text.replace(/^event (\d+) /m, "EDITED $1 ");
  const saved = await ask({
    op: "part.write",
    path,
    offset: second.offset,
    length,
    text: edited,
    version: first.version,
  });
  expect(saved).toMatchObject({ ok: true, version: expect.any(String) });
  expect(saved.version).not.toBe(first.version);
  const after = await whole();
  expect(after).toBe(
    big.slice(0, first.text.length) + edited + big.slice(first.text.length + text.length),
  );
});

test("a part saved after the file changed names the newer version and writes nothing", async () => {
  const { ask, whole } = await connect();
  const first = await ask({ op: "page", path, offset: 0 });
  const elsewhere = await ask({
    op: "part.write",
    path,
    offset: 0,
    length: 6,
    text: "EVENT ",
    version: first.version,
  });
  expect(elsewhere).toMatchObject({ ok: true, version: expect.any(String) });
  const stale = await ask({
    op: "part.write",
    path,
    offset: 0,
    length: 6,
    text: "stale ",
    version: first.version,
  });
  expect(stale).toMatchObject({ ok: true, conflict: elsewhere.version });
  expect((await whole()).startsWith("EVENT 0")).toBe(true);
});
