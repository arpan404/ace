import { z } from "zod";
import { Worker } from "node:worker_threads";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { createFileSink, recentThreadEvents, type LogWorkerRuntime } from "./index.ts";
import { temporary } from "./test-support.ts";

async function watchWorker(home: string, kind: string): Promise<LogWorkerRuntime> {
  const wrapper = join(home, "watch-worker.mjs");
  await writeFile(
    wrapper,
    `import {parentPort,workerData} from 'node:worker_threads';
const send=parentPort.postMessage.bind(parentPort);
parentPort.postMessage=value=>{send({[workerData.watchKind]:['file:///dependency.ts']});send(value);};
await import(workerData.entry);`,
  );
  return {
    spawn(url, data) {
      return new Worker(wrapper, {
        workerData: {
          ...z.record(z.string(), z.unknown()).parse(data),
          entry: url.href,
          watchKind: kind,
        },
        env: { HOME: home },
      });
    },
    schedule: () => () => {},
    deadlineMs: 5000,
  };
}

test.each(["watch:import", "watch:require"])(
  "%s does not consume thread export batches",
  async (kind) => {
    const home = await temporary();
    const path = join(home, "events.sqlite");
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY, at INTEGER, type TEXT, payload TEXT)");
      const insert = db.prepare("INSERT INTO events VALUES(?,0,'message',?)");
      for (let seq = 1; seq <= 33; seq++)
        insert.run(seq, JSON.stringify({ text: `exported-${seq}` }));
    } finally {
      db.close();
    }
    const lines: string[] = [];
    for await (const line of recentThreadEvents(path, await watchWorker(home, kind)))
      lines.push(line);
    expect(lines.map((line) => JSON.parse(line).payload.text)).toEqual(
      Array.from({ length: 33 }, (_, index) => `exported-${index + 1}`),
    );
  },
);

test.each(["watch:import", "watch:require"])(
  "%s cannot cancel a stalled log worker's readiness deadline",
  async (kind) => {
    const home = await temporary();
    const delivered = Promise.withResolvers<void>();
    let owned:Worker|undefined;
    let expire: (() => void) | undefined;
    const sink = createFileSink(
      { directory: home, fileBytes: 65536, totalBytes: 131072, context: {} },
      {
        spawn() {
          const worker = new Worker(
            `const {parentPort}=require('node:worker_threads');parentPort.postMessage({${JSON.stringify(kind)}:['dependency']});setInterval(()=>{},1000);`,
            { eval: true, env: { HOME: home } },
          );
          owned = worker;
          worker.once("message", () => delivered.resolve());
          return worker;
        },
        schedule(callback) {
          expire = callback;
          return () => {
            expire = undefined;
          };
        },
        deadlineMs: 5000,
      },
    );
    const rejected = expect(sink).rejects.toThrow("Log worker timed out");
    void rejected.catch(()=>{});
    try {
      await delivered.promise;
      if (!expire) throw new Error("Watch notification cancelled the readiness deadline");
      expire();
      await rejected;
    } finally { await owned?.terminate(); }
  },
);

test.each(["watch:import", "watch:require"])(
  "%s preserves log readiness and acknowledgements",
  async (kind) => {
    const home = await temporary();
    const sink = await createFileSink(
      { directory: home, fileBytes: 65536, totalBytes: 131072, context: {} },
      await watchWorker(home, kind),
    );
    try {
      for (const message of ["first acknowledged batch", "second acknowledged batch"])
        await sink.write([{ at: 0, level: "info", component: "watch", message, data: {} }]);
      expect(
        (await readFile(join(home, "ace.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).message),
      ).toEqual(["first acknowledged batch", "second acknowledged batch"]);
    } finally {
      await sink.close();
    }
  },
);
