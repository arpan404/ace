import { expect, test } from "vitest";
import { FILE_READ_PART, FILE_REQUESTS_PER_CONNECTION } from "@ace/protocol";
import { readBudgetOf } from "./file-read-budget.ts";
import { readFile, type FileReader } from "./file-read.ts";

const megabyte = 1024 * 1024;
type Reply = Awaited<ReturnType<FileReader["request"]>>;

interface Sent {
  path: string;
  offset: number;
  answer: () => void;
  busy: () => void;
}

/**
 * A daemon connection in a test: files of known sizes, each byte the file's number, and a
 * daemon that refuses with BUSY past its per-connection limit, as the real one does. Requests
 * wait in `sent` until the test answers them (or `auto` answers each on the next turn).
 */
function daemon(files: Record<string, number>, auto = true) {
  const sent: Sent[] = [];
  /** Every request's path, in the order sent. */
  const asked: string[] = [];
  const done: string[] = [];
  let inFlight = 0;
  let most = 0;
  let refused = 0;
  const fill = (path: string) => Object.keys(files).indexOf(path) + 1;
  const client: FileReader = {
    request(input, options) {
      const operation = input.operation;
      if (operation.op !== "read") throw new Error("only reads");
      const { path } = operation;
      const offset = operation.offset ?? 0;
      asked.push(path);
      inFlight++;
      most = Math.max(most, inFlight);
      if (inFlight > FILE_REQUESTS_PER_CONNECTION) refused++;
      return new Promise<Reply>((resolve, reject) => {
        const finish = (reply: Reply) => {
          inFlight--;
          resolve(reply);
        };
        options?.signal?.addEventListener("abort", () => {
          const at = sent.indexOf(entry);
          if (at < 0) return;
          sent.splice(at, 1);
          inFlight--;
          reject(new Error("aborted"));
        });
        const size = files[path] ?? 0;
        const length = Math.min(FILE_READ_PART, size - offset);
        const answer = () => {
          if (offset + length >= size) done.push(path);
          finish({
            type: "files.result",
            requestId: "r",
            value: {
              path,
              version: "v1",
              type: "file",
              size,
              offset,
              encoding: "identity",
              data: Buffer.alloc(length, fill(path)).toString("base64"),
            },
          });
        };
        const busy = () =>
          finish({
            type: "files.error",
            requestId: "r",
            code: "BUSY",
            message: "File request limit",
          });
        const entry: Sent = { path, offset, answer, busy };
        sent.push(entry);
        if (auto)
          setTimeout(() => (inFlight > FILE_REQUESTS_PER_CONNECTION ? busy() : answer()), 1);
      });
    },
  };
  return {
    client,
    sent,
    asked,
    done,
    stats: () => ({ most, refused }),
    /** Answer every request waiting now, oldest first. */
    answerAll() {
      for (const each of sent.splice(0)) each.answer();
    },
    /** How many requests were ever sent for `path`. */
    count: (path: string) => asked.filter((each) => each === path).length,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("three 1 MB files opened at once all arrive and never overrun the daemon's limit", async () => {
  const fake = daemon({ "a.ts": megabyte, "b.ts": megabyte, "c.ts": megabyte });
  const reads = await Promise.all(
    ["a.ts", "b.ts", "c.ts"].map((path) =>
      readFile(fake.client, { threadId: "t1" as never, path, maxSize: 4 * megabyte }),
    ),
  );
  expect(fake.stats().most).toBeLessThanOrEqual(FILE_REQUESTS_PER_CONNECTION);
  expect(fake.stats().refused).toBe(0);
  reads.forEach((read, index) => {
    expect(read.kind).toBe("file");
    if (read.kind !== "file") return;
    expect(read.bytes.length).toBe(megabyte);
    expect(read.bytes.every((byte) => byte === index + 1)).toBe(true);
  });
});

test("the focused file finishes before big prefetches that were asked for first", async () => {
  const fake = daemon(
    { "ahead1.ts": 4 * megabyte, "ahead2.ts": 4 * megabyte, "open.ts": megabyte },
    false,
  );
  const input = (path: string) => ({ threadId: "t1" as never, path, maxSize: 8 * megabyte });
  const reads = [
    readFile(fake.client, input("ahead1.ts"), { priority: "background" }),
    readFile(fake.client, input("ahead2.ts"), { priority: "background" }),
    readFile(fake.client, input("open.ts"), { priority: "focused" }),
  ];
  while (fake.done.length < 3) {
    fake.answerAll();
    await settle();
  }
  await Promise.all(reads);
  expect(fake.done[0]).toBe("open.ts");
});

test("a prefetch the person then opens moves ahead of other prefetches", async () => {
  const fake = daemon({ "other.ts": 2 * megabyte, "hover.ts": 2 * megabyte }, false);
  const input = (path: string) => ({ threadId: "t1" as never, path, maxSize: 4 * megabyte });
  let hover: "background" | "visible" = "background";
  const reads = [
    readFile(fake.client, input("other.ts"), { priority: "background" }),
    readFile(fake.client, input("hover.ts"), { priority: () => hover }),
  ];
  await settle();
  hover = "visible";
  while (fake.done.length < 2) {
    fake.answerAll();
    await settle();
  }
  await Promise.all(reads);
  expect(fake.done[0]).toBe("hover.ts");
});

test("closing a tab withdraws its queued reads and the next file takes their slots", async () => {
  const fake = daemon({ "closed.ts": 4 * megabyte, "next.ts": megabyte }, false);
  const input = (path: string) => ({ threadId: "t1" as never, path, maxSize: 8 * megabyte });
  const tab = new AbortController();
  const closed = readFile(fake.client, input("closed.ts"), { signal: tab.signal });
  closed.catch(() => {});
  const next = readFile(fake.client, input("next.ts"));
  // Both first parts go out; then closed.ts queues its fifteen remaining parts ahead of next.ts.
  fake.answerAll();
  await settle();
  const before = fake.count("closed.ts");
  expect(before).toBeLessThan(16);
  tab.abort();
  await expect(closed).rejects.toThrow();
  while (fake.done.length < 1) {
    fake.answerAll();
    await settle();
  }
  await expect(next).resolves.toMatchObject({ kind: "file" });
  // The parts still queued when the tab closed were never sent.
  expect(fake.count("closed.ts")).toBe(before);
  expect(fake.done).toEqual(["next.ts"]);
});

test("a BUSY reply from the daemon is retried and the read succeeds", async () => {
  const fake = daemon({ "a.ts": 1000 }, false);
  const waits: number[] = [];
  readBudgetOf(fake.client, {
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  const read = readFile(fake.client, { threadId: "t1" as never, path: "a.ts", maxSize: megabyte });
  await settle();
  fake.sent.shift()?.busy();
  await settle();
  fake.sent.shift()?.busy();
  await settle();
  fake.answerAll();
  await expect(read).resolves.toMatchObject({ kind: "file" });
  expect(waits).toHaveLength(2);
  expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
});

test("a daemon that stays BUSY fails the read after a bounded number of tries", async () => {
  const fake = daemon({ "a.ts": 1000 }, false);
  readBudgetOf(fake.client, { wait: async () => {} });
  const read = readFile(fake.client, { threadId: "t1" as never, path: "a.ts", maxSize: megabyte });
  read.catch(() => {});
  let tries = 0;
  for (let round = 0; round < 20 && fake.sent.length + tries < 20; round++) {
    await settle();
    const each = fake.sent.shift();
    if (!each) break;
    tries++;
    each.busy();
  }
  await expect(read).rejects.toMatchObject({ code: "daemon", message: "BUSY" });
  expect(tries).toBeGreaterThan(1);
  expect(tries).toBeLessThan(10);
});
