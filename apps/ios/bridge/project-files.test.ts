import { latest, native, until } from "./test-native.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId, ThreadId } from "@ace/protocol";
import { PatchPump } from "./patches.ts";
import { ComposeActions } from "./compose-actions.ts";
import { filesLimits } from "./project-files.ts";

/*
 * A thread's Files sheet over the real SDK and an in-process fake daemon: the daemon's listing
 * shown a folder at a time within the row cap, and previews cut at the byte and text caps.
 */

const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
let client: ClientCore | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  native.frames.length = 0;
});

async function connect(): Promise<{ owner: ClientCore; compose: ComposeActions }> {
  const daemon = new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "t" });
  daemon.createThread({ id: "ios-files", workspaceId: "ace", title: "Files", provider: "claude" });
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-files-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(daemon),
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
  return {
    owner,
    compose: new ComposeActions(
      owner,
      pump,
      (text, limit) => text.slice(0, limit),
      () => 0,
    ),
  };
}

/** Put a file in the thread's checkout, as an agent would have. */
async function write(owner: ClientCore, path: string, text: string): Promise<void> {
  const reply = await owner.request({
    type: "files.request",
    threadId: ThreadId.parse("ios-files"),
    operation: { op: "create", path, expected: null, text },
  });
  if (reply.type !== "files.result") throw new Error(`write failed: ${JSON.stringify(reply)}`);
}

const listing = (folder: string) =>
  until(() => {
    const patch = latest("files.listing");
    return patch?.folder === folder && patch.state === "ready" && patch;
  });

test("a folder with more files than the row cap shows the cap and counts the rest", async () => {
  const { owner, compose } = await connect();
  const folder = await owner.request({
    type: "files.request",
    threadId: ThreadId.parse("ios-files"),
    operation: { op: "mkdir", path: "many", expected: null },
  });
  expect(folder.type).toBe("files.result");
  for (let index = 0; index < 250; index++)
    await write(owner, `many/file-${String(index).padStart(3, "0")}.ts`, "export {};\n");
  compose.files({ kind: "open", threadId: "ios-files" });
  const root = await listing("");
  const rows = root.rows as { path: string; name: string; folder: boolean }[];
  expect(rows.find((row) => row.name === "many")).toMatchObject({ path: "many/", folder: true });
  // Folders come before files.
  expect(rows.findIndex((row) => !row.folder)).toBeGreaterThan(
    rows.findLastIndex((row) => row.folder),
  );
  compose.files({ kind: "folder", path: "many/" });
  const many = await listing("many/");
  expect((many.rows as unknown[]).length).toBe(filesLimits.rows);
  expect(many.hidden).toBe(50);
  expect((many.rows as { name: string }[])[0]?.name).toBe("file-000.ts");
});

test("a large file's preview stops at the caps and says it was cut; a small one is whole", async () => {
  const { owner, compose } = await connect();
  const line = "x".repeat(99);
  await write(owner, "big.log", `${line}\n`.repeat(3000));
  await write(owner, "small.md", "# Notes\n\nShort file.\n");
  compose.files({ kind: "open", threadId: "ios-files" });
  await listing("");
  compose.files({ kind: "preview", path: "big.log" });
  const big = await until(() => {
    const patch = latest("files.preview");
    return patch?.path === "big.log" && patch.state === "ready" && patch;
  });
  expect(big.truncated).toBe(true);
  expect(String(big.text).length).toBeLessThanOrEqual(filesLimits.units);
  expect(
    String(big.text)
      .split("\n")
      .every((shown) => shown === line),
  ).toBe(true);
  compose.files({ kind: "preview", path: "small.md" });
  const small = await until(() => {
    const patch = latest("files.preview");
    return patch?.path === "small.md" && patch.state === "ready" && patch;
  });
  expect(small).toMatchObject({
    text: "# Notes\n\nShort file.\n",
    truncated: false,
    binary: false,
  });
});

test("search finds files anywhere in the checkout through the daemon", async () => {
  const { compose } = await connect();
  compose.files({ kind: "open", threadId: "ios-files" });
  await listing("");
  compose.files({ kind: "search", query: "outbox" });
  const found = await until(
    () => latest("files.search")?.state === "ready" && latest("files.search"),
  );
  expect((found.paths as string[]).some((path) => path.endsWith("outbox.ts"))).toBe(true);
});
