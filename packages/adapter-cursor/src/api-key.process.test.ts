import { FileCredentialStore, Cursor } from "@cursor/sdk";
import { saveCursorApiKey, cursorApiKeyEntry } from "@ace/adapter-cursor/auth";
import { mkdtemp, readFile, stat, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cursorSdkEnvironment } from "@ace/adapter-cursor/instance";
import { spawnRawSupervised } from "@ace/provider-kit/process";

test("the official SDK writes only its selected credential store and clears the hand-off buffer", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-sdk-key-"));
  const own = join(home, "selected", ".cursor", "sdk", "auth.json");
  const sibling = join(home, "other", ".cursor", "sdk", "auth.json");
  await mkdir(join(home, "other", ".cursor", "sdk"), { recursive: true });
  await writeFile(sibling, "other-account-marker");
  class SelectedStore extends FileCredentialStore {
    constructor() {
      super(own);
    }
  }
  const key = Buffer.from("sdk-synthetic-key-not-a-live-credential");
  try {
    expect(
      await saveCursorApiKey(key, {
        sdk: { FileCredentialStore: SelectedStore },
        backendUrl: "https://api2.cursor.sh",
        now: () => 1000,
      }),
    ).toBeUndefined();
    expect(key.every((byte) => byte === 0)).toBe(true);
    const status = await Cursor.auth.status({ store: new SelectedStore() });
    expect(status.status).toBe("logged-in");
    expect(JSON.stringify(status)).not.toContain("sdk-synthetic-key-not-a-live-credential");
    expect((await stat(own)).mode & 0o777).toBe(0o600);
    expect(await readFile(sibling, "utf8")).toBe("other-account-marker");
    await Cursor.auth.logout({ store: new SelectedStore() });
    expect((await Cursor.auth.status({ store: new SelectedStore() })).status).toBe("logged-out");
  } finally {
    key.fill(0);
    await rm(home, { recursive: true, force: true });
  }
});

test("an SDK credential-store failure still zeroes the hand-off buffer", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-sdk-key-failure-"));
  const blocked = join(home, "not-a-directory");
  await writeFile(blocked, "marker");
  class BrokenStore extends FileCredentialStore {
    constructor() {
      super(join(blocked, "auth.json"));
    }
  }
  const key = Buffer.from("sdk-synthetic-key-not-a-live-credential");
  try {
    await expect(
      saveCursorApiKey(key, {
        sdk: { FileCredentialStore: BrokenStore },
        backendUrl: "https://api2.cursor.sh",
        now: () => 1000,
      }),
    ).rejects.toThrow();
    expect(key.every((byte) => byte === 0)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the isolated credential worker saves stdin through the SDK without diagnostics", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-sdk-key-worker-")));
  const user = join(home, "user");
  await mkdir(user);
  const sentinel = "sdk-worker-synthetic-key-not-a-live-credential";
  const worker = spawnRawSupervised({
    command: process.execPath,
    name: "synthetic credential-store worker",
    args: [cursorApiKeyEntry()],
    cwd: home,
    env: cursorSdkEnvironment(
      { id: "test-key-account", homeDir: home },
      {
        ...process.env,
        CURSOR_API_KEY: undefined,
      },
    ),
    maxOutputBytes: 4096,
  });
  const output: string[] = [];
  worker.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  worker.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  try {
    worker.stdin.end(sentinel + "\n");
    expect(await worker.exited).toMatchObject({ code: 0, reason: "exit" });
    expect(output.join("")).toBe("");
    const store = new FileCredentialStore(join(user, ".cursor", "sdk", "auth.json"));
    expect(await store.load()).toMatchObject({
      apiKey: sentinel,
      backendUrl: "https://api2.cursor.sh",
    });
    expect(await Cursor.auth.status({ store })).toMatchObject({ status: "logged-in" });
    expect((await stat(join(user, ".cursor", "sdk", "auth.json"))).mode & 0o777).toBe(0o600);
  } finally {
    await worker.stop();
    await rm(home, { recursive: true, force: true });
  }
});
