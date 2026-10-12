import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { expect, it } from "vitest";
import { recentThreadEvents, writeSupportBundle } from "@ace/diagnostics";
import { controlledWorker, temporary, unpack } from "./test-support.ts";

it("thread exports mask configured title fragments before a worker normalizes their JSON", async () => {
  const root = await temporary();
  const path = join(root, "events.sqlite");
  const title = '{ "value": "OPAQUE_ENV_CREDENTIAL" }';
  const context = { env: { CUSTOM: title } };
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY, at INTEGER, type TEXT, payload TEXT)");
    db.prepare("INSERT INTO events VALUES(1,1,'thread.updated',?)").run(
      JSON.stringify({ threadId: "thread-1", title }),
    );
  } finally {
    db.close();
  }
  const output = join(root, "support.tar.gz");
  await writeSupportBundle({
    logsDirectory: join(root, "missing"),
    temporaryRoot: root,
    output: createWriteStream(output),
    report: { at: 1, checks: [] },
    versions: {},
    settings: {},
    includeThreads: true,
    redact: createDiagnosticRedactor(context),
    threads: () => recentThreadEvents(path, context, controlledWorker),
  });
  const threads = (await unpack(output)).get("threads.jsonl");
  expect(threads).not.toContain("OPAQUE_ENV_CREDENTIAL");
  expect(JSON.parse(threads ?? "null")).toMatchObject({
    seq: 1,
    type: "thread.updated",
    payload: { threadId: "thread-1", title: "<ENV>" },
  });
});
