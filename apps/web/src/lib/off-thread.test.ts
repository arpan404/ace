import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { offThread } from "./off-thread.ts";

const request = z.object({ id: z.number(), input: z.unknown() });
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly sent: z.infer<typeof request>[] = [];
  terminated = false;
  constructor() {
    super();
    FakeWorker.instances.push(this);
  }
  postMessage(input: unknown) {
    this.sent.push(request.parse(input));
  }
  terminate() {
    this.terminated = true;
  }
  reply(index: number, output: string) {
    const sent = this.sent[index];
    if (!sent) throw new Error("Missing worker request");
    this.dispatchEvent(new MessageEvent("message", { data: { id: sent.id, output } }));
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});
function workerJobs() {
  vi.stubGlobal("Worker", FakeWorker);
  return offThread<string, string>({
    spawn: () => new Worker("/fake-worker.js"),
    local: (input) => input,
    decode: (output) => z.string().parse(output),
  });
}

test("a pre-aborted job neither spawns a worker nor invokes fallback work", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(workerJobs().run("obsolete", controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(FakeWorker.instances).toHaveLength(0);
  vi.stubGlobal("Worker", undefined);
  const local = vi.fn((input: string) => input);
  const fallback = offThread({ spawn: () => new Worker("/unused.js"), local, decode: String });
  await expect(fallback.run("obsolete", controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(local).not.toHaveBeenCalled();
});

test("canceling the last worker job stops CPU and a fresh generation ignores obsolete events", async () => {
  const jobs = workerJobs();
  const controller = new AbortController();
  const obsolete = jobs.run("old", controller.signal);
  const rejected = expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
  const old = FakeWorker.instances[0];
  if (!old) throw new Error("Missing first worker");
  controller.abort();
  await rejected;
  expect(old.terminated).toBe(true);
  const fresh = jobs.run("current");
  const current = FakeWorker.instances[1];
  if (!current) throw new Error("Missing replacement worker");
  old.reply(0, "obsolete");
  old.dispatchEvent(new Event("error"));
  expect(current.terminated).toBe(false);
  current.reply(0, "fresh result");
  expect(await fresh).toBe("fresh result");
});

test("canceling one caller preserves another caller sharing the worker", async () => {
  const jobs = workerJobs();
  const left = new AbortController();
  const right = new AbortController();
  const obsolete = jobs.run("old", left.signal);
  const current = jobs.run("current", right.signal);
  const rejected = expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
  const worker = FakeWorker.instances[0];
  if (!worker) throw new Error("Missing shared worker");
  left.abort();
  await rejected;
  expect(worker.terminated).toBe(false);
  worker.reply(1, "current result");
  expect(await current).toBe("current result");
  // A canceled job can still be computing after the other reply. Once no caller needs this
  // worker, termination must stop that abandoned work rather than leave it in the background.
  expect(worker.terminated).toBe(true);
  right.abort();
  const reused = jobs.run("reused");
  const fresh = FakeWorker.instances[1];
  if (!fresh) throw new Error("Missing replacement worker");
  worker.reply(0, "obsolete");
  fresh.reply(0, "reused result");
  expect(await reused).toBe("reused result");
  expect(FakeWorker.instances).toHaveLength(2);
});

test("aborting a completed caller keeps its idle worker available for later work", async () => {
  const jobs = workerJobs();
  const controller = new AbortController();
  const first = jobs.run("first", controller.signal);
  const worker = FakeWorker.instances[0];
  if (!worker) throw new Error("Missing worker");
  worker.reply(0, "first result");
  expect(await first).toBe("first result");
  controller.abort();
  expect(worker.terminated).toBe(false);
  const next = jobs.run("next");
  worker.reply(1, "next result");
  expect(await next).toBe("next result");
  expect(FakeWorker.instances).toHaveLength(1);
});

test("canceling asynchronous fallback work discards its result after it finishes", async () => {
  vi.stubGlobal("Worker", undefined);
  const gate = Promise.withResolvers<string>();
  const jobs = offThread({
    spawn: () => new Worker("/unused.js"),
    local: () => gate.promise,
    decode: String,
  });
  const controller = new AbortController();
  const result = jobs.run("obsolete", controller.signal);
  controller.abort();
  gate.resolve("obsolete result");
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});
