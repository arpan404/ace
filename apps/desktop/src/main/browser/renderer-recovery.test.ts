import { expect, it } from "vitest";
import { RendererRecovery } from "./renderer-recovery.ts";

it("a recovered renderer survives its old watchdog and a later crash gets a new deadline", () => {
  const callbacks: (() => void)[] = [];
  const cancelled: number[] = [];
  let lost = 0;
  const recovery = new RendererRecovery(
    (_ms, run) => {
      callbacks.push(run);
      const id = callbacks.length;
      return () => {
        cancelled.push(id);
      };
    },
    () => {
      lost++;
    },
  );
  recovery.start();
  expect(recovery.active).toBe(true);
  recovery.ready();
  expect(recovery.active).toBe(false);
  expect(cancelled).toEqual([1]);
  callbacks[0]?.();
  expect(lost).toBe(0);
  recovery.start();
  callbacks[0]?.();
  expect(recovery.active).toBe(true);
  callbacks[1]?.();
  expect(lost).toBe(1);
  expect(recovery.active).toBe(false);
});
