import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createLogger } from "@ace/diagnostics";
import { decodeStreamMessage, StreamAssembler } from "@ace/browser/stream";
import { MediaTestClient } from "@ace/media/testing/media-test-client";
import { Resources } from "./resources.ts";
import { startMedia } from "./media.ts";
import { tabProducer } from "../media-relay/testing-producer.ts";
import { until } from "../media-relay/testing-relay.ts";

// ace-media is the only media path: the daemon starts it reading no media setting at all, so a
// fresh install (or one whose opt-in setting is gone) still shows live views. The real binary,
// from the Cargo build (`native/media/target`) or ACE_MEDIA_PATH.
const root = fileURLToPath(new URL("../../../../native/media/target/", import.meta.url));
const built =
  process.env.ACE_MEDIA_PATH?.trim() ||
  ["debug", "release"].map((p) => join(root, p, "ace-media")).find((path) => existsSync(path));

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

it.skipIf(!built || process.platform === "win32")(
  "a daemon with no media settings at all starts ace-media, and a tab's pictures reach its viewer",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ace-media-start-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const resources = new Resources();
    cleanups.push(() => resources.close());
    let ids = 0;
    // No settings service at all: there is no media.* key to read, and none is asked for.
    const services = {};
    const media = startMedia({
      services,
      id: () => `id-${++ids}`,
      resources,
      config: { dataDir },
      log: createLogger({
        now: () => 0,
        redact: (value) => value,
        sink: { write: async () => {}, close: async () => {} },
      }),
    });
    if (!media) throw new Error("no ace-media on this machine");
    // A tab producer streams into it, without any setting turning that on.
    const producer = tabProducer("t1");
    cleanups.push(() => producer.stop());
    const source = media.attach(producer);
    cleanups.push(() => source.close());
    await until(() => media.routed("tab") && source.streaming(), 10_000);
    const delivery = media.delivery();
    if (!delivery) throw new Error("no delivery");
    const owner = {
      session: "s1",
      device: "phone",
      admission: { kind: "pairing", generation: "g1" },
    } as const;
    const grant = await delivery.connect(owner);
    if (!grant.ok) throw new Error(`media.connect: ${grant.code} ${grant.message}`);
    const pictures: boolean[] = [];
    const assembler = new StreamAssembler();
    const client = await MediaTestClient.open(grant, {
      onPiece: (piece) => {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message?.kind === "browser.video") pictures.push(message.chunk.key);
      },
    });
    cleanups.push(() => client.close());
    expect(
      delivery.bind({
        requester: owner,
        connection: grant.connection,
        target: { kind: "browser", threadId: "t1" },
        codecs: ["avc1.42E033"],
        viewport: { width: 800, height: 600, dpr: 1, scale: 1 },
        local: true,
        audio: false,
        shows: (p) => p.threadId === "t1",
      }),
    ).toMatch(/^view-/);
    await until(() => pictures.length > 0, 10_000);
    expect(pictures[0]).toBe(true);
  },
  30_000,
);

it.skipIf(process.platform === "win32" || !existsSync("/bin/false"))(
  "ace-media that won't start is never swallowed: views and media connections are told why",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ace-media-broken-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const resources = new Resources();
    cleanups.push(() => resources.close());
    const before = process.env.ACE_MEDIA_PATH;
    process.env.ACE_MEDIA_PATH = "/bin/false";
    cleanups.push(() => {
      if (before === undefined) delete process.env.ACE_MEDIA_PATH;
      else process.env.ACE_MEDIA_PATH = before;
    });
    const media = startMedia({
      services: {},
      id: () => "id",
      resources,
      config: { dataDir },
      log: createLogger({
        now: () => 0,
        redact: (value) => value,
        sink: { write: async () => {}, close: async () => {} },
      }),
    });
    if (!media) throw new Error("the binary was not found");
    await until(() => media.delivery() !== undefined, 10_000);
    const delivery = media.delivery();
    expect(delivery?.unserved("tab")).toMatch(/^Live video can't start: ace's media process/);
    const answer = await delivery?.connect({
      session: "s1",
      device: "phone",
      admission: { kind: "pairing", generation: "g1" },
    });
    expect(answer).toMatchObject({
      ok: false,
      code: "unavailable",
      message: delivery?.unserved("tab"),
    });
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "a binary that fails at once is tried again only after a cooldown, however often clients ask",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ace-media-cooldown-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const resources = new Resources();
    cleanups.push(() => resources.close());
    // Each run of this "ace-media" leaves a line, then fails at once.
    const runs = join(dataDir, "runs");
    const fake = join(dataDir, "ace-media");
    await writeFile(fake, `#!/bin/sh\necho run >> ${JSON.stringify(runs)}\nexit 1\n`);
    await chmod(fake, 0o755);
    const count = async () => (await readFile(runs, "utf8").catch(() => "")).split("\n").length - 1;
    const before = process.env.ACE_MEDIA_PATH;
    process.env.ACE_MEDIA_PATH = fake;
    cleanups.push(() => {
      if (before === undefined) delete process.env.ACE_MEDIA_PATH;
      else process.env.ACE_MEDIA_PATH = before;
    });
    const media = startMedia({
      services: {},
      id: () => "id",
      resources,
      config: { dataDir },
      log: createLogger({
        now: () => 0,
        redact: (value) => value,
        sink: { write: async () => {}, close: async () => {} },
      }),
    });
    if (!media) throw new Error("the binary was not found");
    await until(() => media.delivery() !== undefined, 10_000);
    expect(await count()).toBe(1);
    const owner = {
      session: "s1",
      device: "phone",
      admission: { kind: "pairing", generation: "g1" },
    } as const;
    // A burst of clients asking for media connections: each is told why, none starts another.
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => media.delivery()?.connect(owner)),
    );
    for (const answer of answers) expect(answer).toMatchObject({ ok: false, code: "unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await count()).toBe(1);
    // Past the first cooldown (1 s), one more ask tries once more.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await media.delivery()?.connect(owner);
    await until(() => false, 300).catch(() => {});
    expect(await count()).toBe(2);
  },
  30_000,
);

it.skipIf(!built || process.platform === "win32")(
  "a failing ace-media replaced by a working one (an update) starts at the next ask, cooldown or not",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ace-media-update-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const resources = new Resources();
    cleanups.push(() => resources.close());
    const fake = join(dataDir, "ace-media");
    await writeFile(fake, "#!/bin/sh\nexit 1\n");
    await chmod(fake, 0o755);
    const before = process.env.ACE_MEDIA_PATH;
    process.env.ACE_MEDIA_PATH = fake;
    cleanups.push(() => {
      if (before === undefined) delete process.env.ACE_MEDIA_PATH;
      else process.env.ACE_MEDIA_PATH = before;
    });
    const media = startMedia({
      services: {},
      id: () => "id",
      resources,
      config: { dataDir },
      log: createLogger({
        now: () => 0,
        redact: (value) => value,
        sink: { write: async () => {}, close: async () => {} },
      }),
    });
    if (!media) throw new Error("the binary was not found");
    await until(() => media.delivery() !== undefined, 10_000);
    expect(media.delivery()?.unserved("tab")).toMatch(/^Live video can't start/);
    // An update puts the real binary where the failing one was, inside the cooldown.
    await rm(fake);
    await writeFile(fake, await readFile(built ?? ""));
    await chmod(fake, 0o755);
    const owner = {
      session: "s1",
      device: "phone",
      admission: { kind: "pairing", generation: "g1" },
    } as const;
    // The next ask (several at once, as reconnecting clients do) starts it at once.
    await Promise.all(Array.from({ length: 3 }, () => media.delivery()?.connect(owner)));
    await until(() => !/can't start/.test(media.delivery()?.unserved("tab") ?? ""), 5_000);
    const grant = await media.delivery()?.connect(owner);
    expect(grant).toMatchObject({ ok: true });
  },
  30_000,
);
