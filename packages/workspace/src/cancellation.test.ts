import { spawn } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { fixture } from "./test-support.ts";

it("cancels posted regex work and awaits the real worker exit before rejecting", async () => {
  let acknowledge: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let exited: Promise<unknown> | undefined;
  let dead = false;
  const { service, file } = await fixture({
    ripgrep: null,
    runtime: {
      worker(url) {
        const worker = new Worker(url, { execArgv: [] });
        exited = once(worker, "exit").then(() => {
          dead = true;
        });
        worker.on("message", (message: unknown) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "started"
          )
            acknowledge?.();
        });
        return worker;
      },
    },
  });
  await file("a", "a".repeat(20_000) + "!");
  const controller = new AbortController();
  const operation = service.search({
    query: "(a+)+$",
    regex: true,
    limit: 10,
    signal: controller.signal,
  });
  const rejected = expect(operation).rejects.toMatchObject({ code: "ABORTED" });
  await started;
  controller.abort();
  await rejected;
  expect(dead).toBe(true);
  await exited;
});
it("cancels after ripgrep begins matching and reaps it before rejecting", async () => {
  let acknowledge: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let dead = false;
  const { service, file } = await fixture({
    runtime: {
      spawn(binary, args, options) {
        const child = spawn(binary, args, options);
        if (args?.includes("--json")) {
          child.stdout?.once("data", () => acknowledge?.());
          child.once("close", () => {
            dead = true;
          });
        }
        return child;
      },
    },
  });
  await file("dense", "a".repeat(1024 * 1024));
  const controller = new AbortController();
  const operation = service.search({ query: "a", limit: 10_000, signal: controller.signal });
  const rejected = expect(operation).rejects.toMatchObject({ code: "ABORTED" });
  await started;
  controller.abort();
  await rejected;
  expect(dead).toBe(true);
});

it("rejects malformed worker requests instead of accepting an unbounded IPC instruction", async () => {
  const { service, file } = await fixture({
    ripgrep: null,
    runtime: {
      worker(url) {
        const worker = new Worker(url, { execArgv: [] });
        const post = worker.postMessage.bind(worker);
        worker.postMessage = () =>
          post({
            text: "needle",
            path: "a",
            source: "needle",
            caseSensitive: true,
            limit: 0,
            lineOffset: 0,
          });
        return worker;
      },
    },
  });
  await file("a", "needle");
  await expect(service.search({ query: "needle", limit: 1 })).rejects.toMatchObject({
    code: "SEARCH_FAILED",
  });
});
