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
} from "./index.ts";
import { temporary } from "./test-support.ts";
const report = { at: 0, checks: [] };
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
  for await (const line of recentThreadEvents(path)) {
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
    const probes = createSystemProbes({ dataDir: root, port: 0, env: {}, moduleOrigin });
    expect(await probes.pty(AbortSignal.timeout(5000))).toBe(false);
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
  const probes = createSystemProbes({ dataDir, port: 0, env: {} });
  const checks = createDoctorChecks(probes).filter((check) => check.id === "disk");
  const result = (await runDoctor(checks, { now: () => 0 })).checks[0];
  expect(result?.status).toBe("ok");
  expect(result?.message).toContain("MiB free");
  await expect(stat(join(root, "new"))).rejects.toThrow();
});
