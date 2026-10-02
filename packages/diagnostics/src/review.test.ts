import { createWriteStream, unlinkSync } from "node:fs";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRedactor } from "@ace/redaction";
import {
  createLogger,
  createFileSink,
  createSystemProbes,
  createDoctorChecks,
  runDoctor,
  writeSupportBundle,
  recentThreadEvents,
  type LogRecord,
} from "./index.ts";
import { temporary, unpack, systemProbeRuntime } from "./test-support.ts";
import { controlledWorker } from "./test-support.ts";
const report = { at: 0, checks: [] };
const fixtureRecord = (message: string): LogRecord => ({
  at: 0,
  level: "info",
  component: "fixture",
  message,
  data: null,
});

it("embedded event payloads, colliding keys and excessive depth cannot leak structural secrets", async () => {
  const redact = createRedactor({ home: "/private/home" });
  const payload = {
    refreshToken: ["OPAQUE_REFRESH_VALUE"],
    password: { value: "OPAQUE_PASSWORD_VALUE" },
  };
  const root = await temporary(),
    path = join(root, "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY, at INTEGER, type TEXT, payload TEXT)");
  db.prepare("INSERT INTO events VALUES(1, 0, 'event', ?)").run(JSON.stringify(payload));
  db.close();
  for await (const line of recentThreadEvents(path, controlledWorker)) {
    const clean = redact(line);
    expect(clean).not.toContain("OPAQUE_REFRESH_VALUE");
    expect(clean).not.toContain("OPAQUE_PASSWORD_VALUE");
  }
  expect(redact(JSON.stringify({ payload: JSON.stringify(payload) }))).not.toContain(
    "OPAQUE_REFRESH_VALUE",
  );
  const collision = JSON.stringify({
    "/private/home": 1,
    "<HOME>": 2,
    refreshToken: ["OPAQUE_COLLISION_TOKEN"],
  });
  expect(redact(collision)).not.toContain("OPAQUE_COLLISION_TOKEN");
  const deep = "[".repeat(10000) + JSON.stringify(payload) + "]".repeat(10000);
  expect(redact(deep)).not.toContain("OPAQUE_REFRESH_VALUE");
  expect(redact(deep)).not.toContain("OPAQUE_PASSWORD_VALUE");
  expect(redact(deep)).toContain("<OMITTED>");
});
it("lowercase authorization schemes never reach the durable log", async () => {
  const directory = await temporary();
  const logger = createLogger({
    sink: await createFileSink({ directory, fileBytes: 4096, totalBytes: 8192, context: {} }),
    now: () => 0,
    redact: createRedactor({}),
  });
  logger.log("info", "Authorization: bearer LOWERCASE_OPAQUE_ACCESS_TOKEN");
  await logger.close();
  expect(await readFile(join(directory, "ace.jsonl"), "utf8")).not.toContain(
    "LOWERCASE_OPAQUE_ACCESS_TOKEN",
  );
});
it("rotation deleting an enumerated log does not abort a valid support archive", async () => {
  const root = await temporary(),
    logs = join(root, "logs");
  await mkdir(logs);
  await writeFile(join(logs, "ace.jsonl"), '"rotate-now"\n');
  await writeFile(join(logs, "ace.1.jsonl"), '"older"\n');
  let rotated = false;
  await expect(
    writeSupportBundle({
      logsDirectory: logs,
      temporaryRoot: root,
      output: createWriteStream(join(root, "bundle.tar.gz")),
      report,
      versions: {},
      settings: {},
      redact: (line) => {
        if (line.includes("rotate-now") && !rotated) {
          rotated = true;
          unlinkSync(join(logs, "ace.1.jsonl"));
        }
        return line;
      },
    }),
  ).resolves.toBeUndefined();
  expect(rotated).toBe(true);
  const entries = await unpack(join(root, "bundle.tar.gz"));
  expect(JSON.parse(entries.get("doctor.json") ?? "null")).toEqual(report);
  expect(entries.get("logs/ace.jsonl")).toBe('"rotate-now"\n');
  expect(entries.has("logs/ace.1.jsonl")).toBe(false);
});
it("PTY discovery cannot load an unrelated module from the caller working directory", async () => {
  const root = await temporary(),
    module = join(root, "node_modules/node-pty");
  await mkdir(module, { recursive: true });
  await writeFile(join(module, "index.js"), "module.exports = { spawn() {} };");
  const installation = join(root, "daemon-install/node_modules/node-pty");
  await mkdir(installation, { recursive: true });
  await writeFile(join(installation, "index.js"), 'module.exports = require("./binding.node");');
  await writeFile(join(installation, "binding.node"), "invalid native ABI fixture");
  const moduleOrigin = pathToFileURL(join(root, "daemon-install/entry.ts"));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const probes = createSystemProbes(
      { dataDir: root, port: 0, env: {}, moduleOrigin },
      systemProbeRuntime,
    );
    expect(await probes.pty(new AbortController().signal)).toBe(false);
  } finally {
    process.chdir(cwd);
  }
});
it("logger contains throwing array and Error getters and does not enumerate arbitrary producer objects", async () => {
  const logger = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact: createRedactor({}),
    schedule: () => {},
  });
  const array: unknown[] = [1];
  Object.defineProperty(array, "0", {
    get() {
      throw new Error("array getter invoked");
    },
  });
  const error = new Error("original");
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("error getter invoked");
    },
  });
  const object = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("unbounded enumeration");
      },
    },
  );
  for (const data of [array, error, object])
    expect(() => logger.log("info", "safe", data)).not.toThrow();
  const data = logger.recent().map((line) => JSON.parse(line).data);
  expect(data).toEqual([
    ["<ACCESSOR OMITTED>"],
    { message: "<ACCESSOR OMITTED>", name: "Error" },
    "<UNPREPARED OBJECT OMITTED>",
  ]);
  await logger.close();
});
it("a first-run data directory under a writable ancestor reports usable disk without creating state", async () => {
  const root = await temporary(),
    dataDir = join(root, "new/nested/data");
  const probes = createSystemProbes({ dataDir, port: 0, env: {} }, systemProbeRuntime);
  const checks = createDoctorChecks(probes).filter((check) => check.id === "disk");
  const result = (await runDoctor(checks, { now: () => 0, schedule: () => () => {} })).checks[0];
  expect(result?.status).toBe("ok");
  expect(result?.message).toContain("MiB free");
  await expect(stat(join(root, "new"))).rejects.toThrow();
});

it("PTY discovery accepts the daemon installation even when cwd contains a broken module", async () => {
  const root = await temporary();
  const installation = join(root, "installed/node_modules/node-pty");
  const unrelated = join(root, "unrelated/node_modules/node-pty");
  await mkdir(installation, { recursive: true });
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(installation, "index.js"), "module.exports = { spawn() {} };");
  await writeFile(join(unrelated, "index.js"), 'throw new Error("wrong installation");');
  const cwd = process.cwd();
  try {
    process.chdir(join(root, "unrelated"));
    const probes = createSystemProbes(
      {
        dataDir: root,
        port: 0,
        env: {},
        moduleOrigin: pathToFileURL(join(root, "installed/entry.ts")),
      },
      systemProbeRuntime,
    );
    expect(await probes.pty(new AbortController().signal)).toBe(true);
  } finally {
    process.chdir(cwd);
  }
});
it("a throwing normalization boundary emits an omission and leaves subsequent logging usable", async () => {
  const stored: unknown[] = [];
  const logger = createLogger({
    now: () => 0,
    redact: createRedactor({}),
    schedule: () => {},
    sink: {
      async write(records) {
        stored.push(...records.map((record) => record.data));
      },
      async close() {},
    },
  });
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    },
  );
  expect(() => logger.log("info", "hostile", proxy)).not.toThrow();
  logger.log("info", "after", ["visible"]);
  expect(logger.recent().map((line) => JSON.parse(line).data)).toEqual([
    "<NORMALIZATION FAILED: DATA OMITTED>",
    ["visible"],
  ]);
  await logger.close();
  expect(stored).toEqual(["<NORMALIZATION FAILED: DATA OMITTED>", ["visible"]]);
});

it("a support archive stays readable while the real log worker rotates recent records", async () => {
  const root = await temporary(),
    logs = join(root, "logs"),
    path = join(root, "rotating.tar.gz");
  const sink = await createFileSink(
    { directory: logs, fileBytes: 256, totalBytes: 1024, context: {} },
    controlledWorker,
  );
  let writing: Promise<void> | undefined;
  try {
    await sink.write(
      Array.from({ length: 6 }, (_, n) => fixtureRecord(`seed-${n}-${"x".repeat(128)}`)),
    );
    await writeSupportBundle({
      logsDirectory: logs,
      temporaryRoot: root,
      output: createWriteStream(path),
      report,
      versions: {},
      settings: {},
      redact(line) {
        if (line.includes("seed-") && !writing)
          writing = sink.write(
            Array.from({ length: 16 }, (_, n) => fixtureRecord(`during-${n}-${"x".repeat(128)}`)),
          );
        return line;
      },
    });
    await writing;
    const entries = await unpack(path);
    expect(JSON.parse(entries.get("doctor.json") ?? "null")).toEqual(report);
    const archiveLogs = [...entries.entries()].filter(([name]) => name.startsWith("logs/"));
    expect(archiveLogs.length).toBeGreaterThan(0);
    for (const [, text] of archiveLogs) {
      for (const line of text.trim().split("\n"))
        expect(JSON.parse(line)).toMatchObject({ component: "fixture", level: "info" });
    }
    expect(await readFile(join(logs, "ace.jsonl"), "utf8")).toContain("during-");
  } finally {
    try {
      await writing;
    } finally {
      await sink.close();
    }
  }
});
