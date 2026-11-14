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

async function connect(seeded: Uint8Array = new TextEncoder().encode(big)) {
  const fake = new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "t" });
  fake.createThread({ id: thread, workspaceId: "ace", title: "Parts", provider: "claude" });
  fake.apply(thread, [facts.rootAgent("claude")]);
  fake.checkouts.seedBytes(thread, path, seeded);
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
  const bytes = async () => {
    const parts: Uint8Array[] = [];
    const input = { threadId: ThreadId.parse(thread), op: "download", path, offset: 0 } as const;
    for await (const part of downloadFile(owner, input, { timeoutMs: 30_000 })) parts.push(part);
    return Buffer.concat(parts);
  };
  const whole = async () => new TextDecoder().decode(await bytes());
  /** Every part as the phone reads them, at the file's current version. */
  const pages = async () => {
    const read: { text: string; offset: number; length: number; version: string }[] = [];
    for (let offset = 0, done = false; !done;) {
      const page = await ask({ op: "page", path, offset, version: read[0]?.version });
      if (page.ok !== true) throw new Error(`page at ${offset}: ${String(page.message)}`);
      const next = page.nextOffset as number;
      read.push({
        text: page.text as string,
        offset,
        length: next - offset,
        version: page.version as string,
      });
      offset = next;
      done = page.done === true;
    }
    return read;
  };
  return { ask, whole, bytes, pages };
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
  const before = first.text as string;
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
  expect(after).toBe(big.slice(0, before.length) + edited + big.slice(before.length + text.length));
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

/** A BOM, CRLF lines, and a line of 3-byte characters longer than a part, so a part ends inside it. */
const awkward = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from("line one\r\ncafé\r\n"),
  Buffer.from(`${"€".repeat(100_000)}\r\n`),
  Buffer.from(Array.from({ length: 3000 }, (_, row) => `row ${row} ü\r\n`).join("")),
]);

test("saving each part as it was read leaves the file byte for byte, BOM, CRLF and split characters included", async () => {
  const { ask, bytes, pages } = await connect(awkward);
  const read = await pages();
  expect(read.length).toBeGreaterThan(2);
  expect(read[0]?.text.startsWith("\uFEFFline one\r\n")).toBe(true);
  // The long line is cut between whole characters, never inside one.
  expect(read.some((part) => part.text.length > 0 && !part.text.endsWith("\n"))).toBe(true);
  let version = read[0]?.version;
  for (const part of read) {
    const saved = await ask({ op: "part.write", path, ...part, version });
    expect(saved).toMatchObject({ ok: true, version: expect.any(String) });
    version = saved.version as string;
    expect((await bytes()).equals(awkward)).toBe(true);
  }
});

test("an edit in a CRLF part changes only the edited bytes", async () => {
  const { ask, bytes, pages } = await connect(awkward);
  const part = (await pages()).find((each) => each.text.includes("row 2000 ü\r\n"));
  if (!part) throw new Error("no part holds row 2000");
  const text = part.text.replace("row 2000 ü\r\n", "ROW 2000 Ü\r\n");
  expect(await ask({ op: "part.write", path, ...part, text })).toMatchObject({ ok: true });
  const expected = Buffer.from(
    new TextDecoder("utf-8", { ignoreBOM: true })
      .decode(awkward)
      .replace("row 2000 ü\r\n", "ROW 2000 Ü\r\n"),
  );
  expect((await bytes()).equals(expected)).toBe(true);
});

test("a part that isn't valid UTF-8 is never saved, so bytes it couldn't show stay as they were", async () => {
  // The stray byte sits in a later part: the first part reads as text, as a mostly-text file does.
  const stray = Buffer.concat([
    Buffer.from(Array.from({ length: 30_000 }, (_, row) => `row ${row} fine\n`).join("")),
    Buffer.from([0x6f, 0x6b, 0xff, 0x62, 0x0a]),
  ]);
  const { ask, bytes, pages } = await connect(stray);
  const part = (await pages()).at(-1);
  if (!part) throw new Error("no part");
  const saved = await ask({ op: "part.write", path, ...part, text: part.text.replace("ok", "OK") });
  expect(saved).toMatchObject({ ok: false, code: "not_utf8" });
  expect((await bytes()).equals(stray)).toBe(true);
});
