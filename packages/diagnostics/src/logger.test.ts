import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRedactor } from "@ace/redaction";
import { createLogger, createFileSink, logFields, type LogRecord } from "./index.ts";
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
    logger.child("provider").log(
      "warn",
      `${tokens.join(" ")} /Users/someone/private`,
      logFields([
        ["password", 42],
        ["nested", logFields([["accessToken", ["unrecognized"]]])],
        ["huge", "sk-" + "a".repeat(10000)],
      ]),
    );
    await logger.flush();
    const file = await readFile(join(directory, "ace.jsonl"), "utf8");
    for (const token of tokens) {
      expect(file).not.toContain(token);
      expect(logger.recent().join("\n")).not.toContain(token);
    }
    expect(file).not.toContain("/Users/someone");
    const record = JSON.parse(file);
    expect(record.message).not.toContain(context.env.CUSTOM);
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
  expect(() =>
    logger.log(
      "info",
      "safe",
      logFields([
        ["self", object],
        ["danger", object],
      ]),
    ),
  ).not.toThrow();
  expect(logger.recent()[0]).toContain("<UNPREPARED OBJECT OMITTED>");
  await logger.close();
});
it("ordinary array values remain available in recent and persisted logs", async () => {
  const directory = await temporary();
  const logger = createLogger({
    sink: await createFileSink({ directory, fileBytes: 4096, totalBytes: 8192, context: {} }),
    now: () => 0,
    redact,
  });
  logger.log("info", "arrays", logFields([["values", ["visible", 7, [true, null]]]]));
  await logger.flush();
  expect(JSON.parse(logger.recent()[0] ?? "null").data.values).toEqual([
    "visible",
    7,
    [true, null],
  ]);
  expect(JSON.parse(await readFile(join(directory, "ace.jsonl"), "utf8")).data.values).toEqual([
    "visible",
    7,
    [true, null],
  ]);
  await logger.close();
});
it("record-wide field and text budgets bound copying and omit oversized keys whole", async () => {
  const logger = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact,
    schedule: () => {},
  });
  const entries: [string, unknown][] = [];
  for (let n = 0; n < 32; n++) entries.push([`value-${n}`, "é".repeat(2000)]);
  entries.unshift(["x".repeat(1000000), "private-value"]);
  logger.log("info", "bounded", logFields(entries));
  const line = logger.recent()[0] ?? "";
  expect(line).not.toContain("private-value");
  expect(line).toContain("OVERSIZED FIELD OMITTED");
  expect(Buffer.byteLength(line)).toBeLessThan(12000);
  await logger.close();
});
it("an Error name accessor cannot replace its safe own message or escape to the producer", async () => {
  const logger = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact,
    schedule: () => {},
  });
  const error = new Error("visible error");
  Object.defineProperty(error, "name", {
    get() {
      throw new Error("name getter invoked");
    },
  });
  expect(() => logger.log("error", "failure", error)).not.toThrow();
  expect(JSON.parse(logger.recent()[0] ?? "null").data).toEqual({
    message: "visible error",
    name: "Error",
  });
  await logger.close();
});

it("raw Errors and diagnostic objects retain redacted message and code without stack, cause or stderr", async () => {
  const directory = await temporary();
  const logger = createLogger({
    sink: await createFileSink({ directory, fileBytes: 65536, totalBytes: 131072, context }),
    now: () => 0,
    redact,
  });
  const message =
    'Cannot list models: {"credentials":{"login":"opaque-login-value"}} Bearer abcdefghijklmnopqrstuvwxyz';
  const extras = {
    code: "ECONNREFUSED",
    stack: "private-stack",
    cause: { message: "private-cause" },
    stderr: "private-stderr",
    env: { CUSTOM: "private-env" },
    token: "private-token",
  };
  try {
    logger.log("warn", "Error failure", Object.assign(new Error(message), extras));
    logger.log("warn", "Object failure", { message, ...extras });
    await logger.flush();
    const persisted = await readFile(join(directory, "ace.jsonl"), "utf8");
    for (const lines of [persisted.trim().split("\n"), logger.recent()]) {
      const summaries = lines.map((line) => JSON.parse(line).data);
      expect(summaries).toEqual([
        {
          message: expect.stringContaining("Cannot list models"),
          code: "ECONNREFUSED",
          name: "Error",
        },
        { message: expect.stringContaining("Cannot list models"), code: "ECONNREFUSED" },
      ]);
      const text = lines.join("\n");
      for (const secret of [
        "opaque-login-value",
        "abcdefghijklmnopqrstuvwxyz",
        "private-stack",
        "private-cause",
        "private-stderr",
        "private-env",
        "private-token",
      ])
        expect(text).not.toContain(secret);
      expect(text).not.toContain("UNPREPARED OBJECT OMITTED");
    }
  } finally {
    await logger.close();
  }
});

it("error summaries omit long and multiline messages whole instead of exposing partial environment secrets", async () => {
  const secret = "opaque-environment-secret";
  const logger = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact: createRedactor({ env: { CUSTOM: secret } }),
    schedule: () => {},
  });
  try {
    logger.log("warn", "long", Object.assign(new Error("x".repeat(500) + secret), { code: "EIO" }));
    logger.log("warn", "multiline", new Error("first line\nprivate-stderr"));
    const lines = logger.recent();
    expect(JSON.parse(lines[0] ?? "null").data).toEqual({
      message: "<OVERSIZED ERROR MESSAGE OMITTED>",
      name: "Error",
      code: "EIO",
    });
    expect(JSON.parse(lines[1] ?? "null").data.message).toBe("<MULTILINE ERROR MESSAGE OMITTED>");
    expect(lines.join("\n")).not.toContain("opaque");
    expect(lines.join("\n")).not.toContain("private-stderr");
  } finally {
    await logger.close();
  }
});

it("debug levels and nested home/worktrees paths survive redaction while credentials stay hidden", async () => {
  const directory = await temporary();
  const logContext = {
    home: join(directory, "user"),
    env: { ACE_LOG_LEVEL: "debug", NODE_ENV: "development", CURSOR_API_KEY: "opaque-sdk-secret" },
  };
  const sink = await createFileSink({
    directory,
    fileBytes: 65536,
    totalBytes: 131072,
    context: logContext,
  });
  const logger = createLogger({
    sink,
    now: () => 1,
    redact: createRedactor(logContext),
    level: "debug",
  });
  const path = join(directory, "home", "worktrees", "project");
  try {
    logger.log(
      "debug",
      "development probe",
      logFields([
        ["cwd", path],
        ["personal", join(logContext.home, "private")],
        ["message", "opaque-sdk-secret"],
      ]),
    );
    await logger.flush();
    const line = await readFile(join(directory, "ace.jsonl"), "utf8");
    const record = JSON.parse(line);
    expect(record.level).toBe("debug");
    expect(record.message).toBe("development probe");
    expect(record.data.cwd).toBe(path);
    expect(record.data.personal).toBe("<HOME>/private");
    expect(line).not.toContain("opaque-sdk-secret");
  } finally {
    await logger.close();
  }
});
