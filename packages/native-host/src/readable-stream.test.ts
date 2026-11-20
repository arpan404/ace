import { describe, expect, test } from "vitest";
import { PortableReadableStream } from "./readable-stream.ts";

const tick = async () => {
  for (let round = 0; round < 10; round++) await Promise.resolve();
};

describe("a readable stream without the engine's", () => {
  test("chunks come out in order, then the end", async () => {
    const stream = new PortableReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.close();
      },
    });
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: 1 });
    expect(await reader.read()).toEqual({ done: false, value: 2 });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("a read waiting for a chunk gets it as it is enqueued", async () => {
    let enqueue: ((value: string) => void) | undefined;
    const stream = new PortableReadableStream<string>({
      start(controller) {
        enqueue = (value) => controller.enqueue(value);
      },
    });
    const pending = stream.getReader().read();
    await tick();
    enqueue?.("late");
    expect(await pending).toEqual({ done: false, value: "late" });
  });

  test("an error rejects waiting and later reads", async () => {
    let fail: (() => void) | undefined;
    const stream = new PortableReadableStream<number>({
      start(controller) {
        fail = () => controller.error(new Error("reset"));
      },
    });
    const reader = stream.getReader();
    const pending = reader.read();
    fail?.();
    await expect(pending).rejects.toThrow("reset");
    await expect(reader.read()).rejects.toThrow("reset");
  });

  test("desired size falls as bytes queue and pull runs once a read frees room", async () => {
    let pulls = 0;
    let control:
      | { enqueue(chunk: Uint8Array): void; readonly desiredSize: number | null }
      | undefined;
    const stream = new PortableReadableStream<Uint8Array>(
      {
        start(controller) {
          control = controller;
        },
        pull() {
          pulls++;
        },
      },
      { highWaterMark: 10, size: (chunk) => chunk.byteLength },
    );
    await tick();
    const before = pulls;
    control?.enqueue(new Uint8Array(10));
    expect(control?.desiredSize).toBe(0);
    await tick();
    expect(pulls).toBe(before);
    await stream.getReader().read();
    await tick();
    expect(control?.desiredSize).toBe(10);
    expect(pulls).toBeGreaterThan(before);
  });

  test("cancelling tells the source and ends the stream", async () => {
    let cancelled = false;
    const stream = new PortableReadableStream<number>({
      cancel() {
        cancelled = true;
      },
    });
    const reader = stream.getReader();
    await reader.cancel();
    expect(cancelled).toBe(true);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("one reader at a time, and a released reader's wait is rejected", async () => {
    const stream = new PortableReadableStream<number>();
    const reader = stream.getReader();
    expect(() => stream.getReader()).toThrow();
    const pending = reader.read();
    reader.releaseLock();
    await expect(pending).rejects.toThrow();
    expect(() => stream.getReader()).not.toThrow();
  });
});
