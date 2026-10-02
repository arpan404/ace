import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRedactor } from "@ace/redaction";
import { createLogger, createFileSink, type LogRecord } from "./index.ts";
import { temporary, deferred } from "./test-support.ts";
const context = {
  home: "/Users/someone",
  env: { CUSTOM: 'custom-credential-"quoted"', SHORT: "1" },
};
const redact = createRedactor(context);
const tokens = [
  "sk-ant-abcdefghijklmnopqrstuv",
  "ghp_abcdefghijklmnopqrstuvwxyz123456",
  "github_pat_abcdefghijklmnopqrstuv",
  "eyJabcdefghijklmnop.abcdefghijklmnop.abcdefghijklmnop",
  "Bearer abcdefghijklmnopqrstuvwxyz",
  "AKIAABCDEFGHIJKLMNOP",
  "AIza" + "a".repeat(35),
  "xoxb-1234567890-abcdefghijklmnop",
  "npm_abcdefghijklmnopqrstuv",
  "sk_live_abcdefghijklmnopqrstuv",
  "Basic YTpi",
  context.env.CUSTOM,
];
it("no known token, home path or environment value reaches the file or recent ring", async () => {
  const directory = await temporary();
  const sink = await createFileSink({ directory, fileBytes: 65536, totalBytes: 131072, context });
  const logger = createLogger({ sink, now: () => 123, redact, level: "debug" });
  try {
    logger.child("provider").log("warn", `${tokens.join(" ")} /Users/someone/private`, {
      password: 42,
      nested: { accessToken: ["unrecognized"] },
      huge: "sk-" + "a".repeat(10000),
    });
    await logger.flush();
    const file = await readFile(join(directory, "ace.jsonl"), "utf8");
    for (const token of tokens) {
      expect(file).not.toContain(token);
      expect(logger.recent().join("\n")).not.toContain(token);
    }
    expect(file).not.toContain("/Users/someone");
    const record = JSON.parse(file);
    expect(record.at).toBe(123);
    expect(record.level).toBe("warn");
    expect(record.component).toBe("ace.provider");
    expect(record.data.password).toBe("<SECRET>");
    expect(record.data.nested.accessToken).toBe("<SECRET>");
    expect((await stat(join(directory, "ace.jsonl"))).mode & 0o777).toBe(0o600);
  } finally {
    await logger.close();
  }
});
it("a full queue drops immediately while a blocked sink owns its batch", async () => {
  const gate = deferred<void>();
  const delivered: LogRecord[] = [];
  const logger = createLogger({
    sink: {
      async write(records) {
        delivered.push(...records);
        await gate.promise;
      },
      async close() {},
    },
    now: () => 0,
    redact,
    capacity: 2,
    recentCapacity: 1,
    batchSize: 1,
    schedule: () => {},
  });
  logger.log("info", "first");
  logger.log("info", "second");
  const flush = logger.flush();
  logger.log("info", "dropped");
  expect(logger.stats()).toEqual({ dropped: 1, failed: 0, queued: 2 });
  expect(logger.recent()).toHaveLength(1);
  expect(logger.recent()[0]).toContain("second");
  gate.resolve();
  await flush;
  expect(delivered.map((record) => record.message)).toEqual(["first", "second"]);
  expect(logger.stats().queued).toBe(0);
  await logger.close();
});
it("child loggers share level filtering and failed writes do not escape to callers", async () => {
  const logger = createLogger({
    sink: {
      async write() {
        throw new Error("disk full");
      },
      async close() {},
    },
    now: () => 0,
    redact,
    level: "warn",
    schedule: () => {},
  });
  logger.child("daemon").log("info", "filtered");
  logger.child("daemon").log("error", "kept");
  await logger.flush();
  expect(logger.stats()).toEqual({ dropped: 0, failed: 1, queued: 0 });
  expect(logger.recent()).toHaveLength(1);
  await logger.close();
  logger.log("error", "closed");
  expect(logger.stats().dropped).toBe(1);
});
it("size rotation and total cap retain only recent complete records across a restart", async () => {
  const directory = await temporary();
  async function write(start: number, end: number) {
    const sink = await createFileSink({ directory, fileBytes: 512, totalBytes: 1024, context: {} });
    const logger = createLogger({ sink, now: () => 0, redact, schedule: () => {} });
    for (let n = start; n < end; n++) logger.log("info", `record-${n} ${"x".repeat(60)}`);
    await logger.close();
  }
  await write(0, 20);
  await write(20, 40);
  const names = await readdir(directory);
  const sizes = await Promise.all(names.map((name) => stat(join(directory, name))));
  expect(sizes.every((s) => s.size <= 512)).toBe(true);
  expect(sizes.reduce((sum, s) => sum + s.size, 0)).toBeLessThanOrEqual(1024);
  const contents = (
    await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")))
  ).join("");
  expect(contents).not.toContain("record-0 ");
  expect(contents).toContain("record-39 ");
  for (const line of contents.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  expect(names.some((name) => name !== "ace.jsonl")).toBe(true);
});
it("logging a circular object or an object with getters does not throw or invoke getters", async () => {
  const logger = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact,
    schedule: () => {},
  });
  const object: Record<string, unknown> = {};
  object.self = object;
  Object.defineProperty(object, "danger", {
    enumerable: true,
    get() {
      throw new Error("getter invoked");
    },
  });
  expect(() => logger.log("info", "safe", object)).not.toThrow();
  expect(logger.recent()[0]).toContain("<CYCLE>");
  await logger.close();
});
