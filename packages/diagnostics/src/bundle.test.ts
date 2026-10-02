import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import { expect, it } from "vitest";
import { createRedactor } from "@ace/redaction";
import { writeSupportBundle } from "./index.ts";
import { temporary } from "./test-support.ts";
async function unpack(path: string) {
  const entries = new Map<string, string>();
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    let text = "";
    stream.on("data", (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected bytes");
      text += chunk.toString();
    });
    stream.on("end", () => {
      entries.set(header.name, text);
      next();
    });
    stream.on("error", (error) => extract.destroy(error));
  });
  await pipeline(createReadStream(path), createGunzip(), extract);
  return entries;
}
const report = {
  at: 0,
  checks: [{ id: "node", status: "ok" as const, message: "Node", fix: "Install" }],
};
it("a support archive contains redacted logs, report, versions and settings, excluding threads by default", async () => {
  const root = await temporary(),
    logs = join(root, "logs"),
    path = join(root, "support.tar.gz");
  await mkdir(logs);
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";
  await writeFile(
    join(logs, "ace.jsonl"),
    JSON.stringify({
      message: secret,
      cwd: "/home/person/repo",
      password: "unusual-password",
      accountId: "private-id",
    }) + "\n",
  );
  await writeFile(join(logs, "credentials.json"), "never include this file");
  await writeSupportBundle({
    logsDirectory: logs,
    temporaryRoot: root,
    output: createWriteStream(path),
    report,
    versions: { node: "v24.0.0" },
    settings: {
      nested: { refreshToken: ["private-array-token"] },
      database: "/home/person/events.sqlite",
    },
    redact: createRedactor({ home: "/home/person" }),
    threads: () => {
      throw new Error("must not read threads");
    },
  });
  const entries = await unpack(path);
  expect([...entries.keys()].toSorted()).toEqual([
    "doctor.json",
    "logs/ace.jsonl",
    "settings.json",
    "versions.json",
  ]);
  const text = [...entries.values()].join("\n");
  for (const value of [
    secret,
    "unusual-password",
    "private-id",
    "private-array-token",
    "/home/person",
    "never include",
  ])
    expect(text).not.toContain(value);
  expect(entries.get("logs/ace.jsonl")).toContain("<SECRET>");
  expect(JSON.parse(entries.get("settings.json") ?? "null").nested.refreshToken).toBe("<SECRET>");
  expect(JSON.parse(entries.get("doctor.json") ?? "null").checks[0].id).toBe("node");
  expect((await readdir(root)).some((name) => name.startsWith("ace-support-"))).toBe(false);
});
it("explicit thread opt-in redacts tokens split between chunks and omits oversized lines whole", async () => {
  const root = await temporary(),
    path = join(root, "support.tar.gz");
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  await writeSupportBundle({
    logsDirectory: join(root, "missing"),
    temporaryRoot: root,
    output: createWriteStream(path),
    report,
    versions: {},
    settings: {},
    redact: createRedactor({}),
    includeThreads: true,
    threads: async function* () {
      yield `visible ${secret.slice(0, 10)}`;
      yield `${secret.slice(10)}\n`;
      yield "too-long-private-line " + "x".repeat(70000);
      yield "\nlast visible\n";
    },
  });
  const contents = (await unpack(path)).get("threads.jsonl");
  expect(contents).toContain("visible <SECRET>");
  expect(contents).not.toContain(secret);
  expect(contents).not.toContain("too-long-private-line");
  expect(contents).toContain("OVERSIZED LINE OMITTED");
  expect(contents).toContain("last visible");
});
it("the bundle byte cap keeps valid tar entries and ignores symlinked logs", async () => {
  const root = await temporary(),
    logs = join(root, "logs"),
    path = join(root, "support.tar.gz");
  await mkdir(logs);
  await writeFile(join(logs, "ace.jsonl"), "safe\n".repeat(5000));
  await writeFile(join(root, "outside"), "private-external-file\n");
  await symlink(join(root, "outside"), join(logs, "ace.1.jsonl"));
  await writeSupportBundle({
    logsDirectory: logs,
    temporaryRoot: root,
    output: createWriteStream(path),
    report,
    versions: {},
    settings: {},
    redact: createRedactor({}),
    maxBytes: 1024,
  });
  const entries = await unpack(path);
  expect(
    [...entries.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0),
  ).toBeLessThanOrEqual(1024);
  expect(entries.get("logs/ace.jsonl")).toContain("safe");
  expect(entries.has("logs/ace.1.jsonl")).toBe(false);
});
it("a failed source rejects the export and removes its private staging files", async () => {
  const root = await temporary();
  await expect(
    writeSupportBundle({
      logsDirectory: join(root, "missing"),
      temporaryRoot: root,
      output: createWriteStream(join(root, "bad.tar.gz")),
      report,
      versions: {},
      settings: {},
      redact: createRedactor({}),
      includeThreads: true,
      threads: async function* () {
        yield "safe\n";
        throw new Error("source broke");
      },
    }),
  ).rejects.toThrow("source broke");
  expect((await readdir(root)).some((name) => name.startsWith("ace-support-"))).toBe(false);
});
it("input work stops at its byte budget even for newline-free sources", async () => {
  const root = await temporary();
  let consumedBytes = 0,
    closed = false;
  await writeSupportBundle({
    logsDirectory: join(root, "missing"),
    temporaryRoot: root,
    output: createWriteStream(join(root, "cap.tar.gz")),
    report,
    versions: {},
    settings: {},
    redact: createRedactor({}),
    maxBytes: 1024,
    maxInputBytes: 4096,
    includeThreads: true,
    threads: async function* () {
      try {
        for (let i = 0; i < 100000; i++) {
          consumedBytes += 256;
          yield "x".repeat(256);
        }
      } finally {
        closed = true;
      }
    },
  });
  expect(consumedBytes).toBeLessThanOrEqual(4096);
  expect(closed).toBe(true);
  expect((await unpack(join(root, "cap.tar.gz"))).get("threads.jsonl")).toContain("INPUT LIMIT");
});
it("a real thread archive strips array and object secrets even inside serialized payloads", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { recentThreadEvents } = await import("./index.ts");
  const root = await temporary(),
    database = join(root, "events.sqlite");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY, at INTEGER, type TEXT, payload TEXT)");
  db.prepare("INSERT INTO events VALUES(1,0,'event',?)").run(
    JSON.stringify({
      refreshToken: ["OPAQUE_REFRESH_VALUE"],
      password: { value: "OPAQUE_PASSWORD_VALUE" },
      visible: ["ordinary", 5],
    }),
  );
  db.close();
  const path = join(root, "real.tar.gz");
  await writeSupportBundle({
    logsDirectory: join(root, "missing"),
    temporaryRoot: root,
    output: createWriteStream(path),
    report,
    versions: {},
    settings: { values: ["ordinary", 5] },
    redact: createRedactor({}),
    includeThreads: true,
    threads: () => recentThreadEvents(database),
  });
  const entries = await unpack(path),
    text = [...entries.values()].join("\n");
  expect(text).not.toContain("OPAQUE_REFRESH_VALUE");
  expect(text).not.toContain("OPAQUE_PASSWORD_VALUE");
  expect(JSON.parse(entries.get("threads.jsonl") ?? "null").payload.visible).toEqual([
    "ordinary",
    5,
  ]);
  expect(JSON.parse(entries.get("settings.json") ?? "null").values).toEqual(["ordinary", 5]);
});
it("aborting an in-flight source cancels export and removes staging", async () => {
  const { deferred } = await import("./test-support.ts");
  const entered = deferred<void>();
  const controller = new AbortController(),
    root = await temporary();
  let closed = false;
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          entered.resolve();
          return new Promise<IteratorResult<string>>(() => {});
        },
        async return() {
          closed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const exportPromise = writeSupportBundle({
    logsDirectory: join(root, "missing"),
    temporaryRoot: root,
    output: createWriteStream(join(root, "abort.tar.gz")),
    report,
    versions: {},
    settings: {},
    redact: createRedactor({}),
    includeThreads: true,
    threads: () => source,
    signal: controller.signal,
  });
  const rejected = expect(exportPromise).rejects.toThrow("Bundle aborted");
  await entered.promise;
  controller.abort();
  await rejected;
  expect(closed).toBe(true);
  expect((await readdir(root)).some((name) => name.startsWith("ace-support-"))).toBe(false);
});
it("internal chunk limits preserve Unicode environment-secret redaction", async () => {
  const root = await temporary(),
    path = join(root, "unicode.tar.gz");
  await writeSupportBundle({
    logsDirectory: join(root, "missing"),
    temporaryRoot: root,
    output: createWriteStream(path),
    report,
    versions: {},
    settings: {},
    redact: createRedactor({ env: { API_KEY: "opaque😀rest" } }),
    includeThreads: true,
    threads: async function* () {
      yield "safe\n".repeat(13105) + "safeopaque😀rest\n";
    },
  });
  const text = (await unpack(path)).get("threads.jsonl") ?? "";
  expect(text).toContain("safe<ENV>\n");
  expect(text).not.toContain("opaque");
  expect(text).not.toContain("�");
});
