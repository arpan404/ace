import { afterEach, expect, it } from "vitest";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { deferred, manager, ready, target } from "./testing/support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
it("capture terminates before a stalled recording publisher can delay shutdown", async () => {
  const publishing = deferred<void>();
  const release = deferred<void>();
  const children: SupervisedProcess[] = [];
  const test = await manager(
    {},
    {
      spawn: (options) => {
        const child = spawnSupervised(options);
        children.push(child);
        return child;
      },
      publishArtifact: async () => {
        publishing.resolve();
        await release.promise;
      },
    },
  );
  cleanups.push(test.close);
  const state = await ready(test.screen);
  await test.screen.startRecording(state.sessionId);
  const stop = test.screen.stop(state.sessionId);
  try {
    await publishing.promise;
    expect(children[0]?.signal.aborted).toBe(true);
    expect(test.screen.state(state.sessionId).indicator).toBe(false);
  } finally {
    release.resolve();
    await stop;
  }
});
it("the visible indicator remains on until helper termination is confirmed", async () => {
  const stopping = deferred<void>();
  const release = deferred<void>();
  const test = await manager(
    {},
    {
      spawn: (options) => {
        const child = spawnSupervised(options);
        return {
          ...child,
          stop: async (stopOptions) => {
            stopping.resolve();
            await release.promise;
            return child.stop(stopOptions);
          },
        };
      },
    },
  );
  cleanups.push(test.close);
  const state = await ready(test.screen);
  const stop = test.screen.stop(state.sessionId);
  try {
    await stopping.promise;
    expect(test.screen.state(state.sessionId).indicator).toBe(true);
    expect(() => test.screen.screenshot(state.sessionId)).toThrow("not live");
  } finally {
    release.resolve();
    await stop;
  }
});
it("disabling and revoking approval terminate the owned processes and remove all sessions", async () => {
  const children: SupervisedProcess[] = [];
  const test = await manager(
    {},
    {
      spawn: (options) => {
        const child = spawnSupervised(options);
        children.push(child);
        return child;
      },
    },
  );
  cleanups.push(test.close);
  await ready(test.screen);
  await test.screen.start(target);
  await test.screen.enable(false);
  expect(test.screen.states()).toEqual([]);
  expect(children.map((child) => child.signal.aborted)).toEqual([true, true]);
  await test.screen.enable(true);
  await test.screen.start(target);
  await test.screen.approve(target.bundleId, false);
  expect(test.screen.states()).toEqual([]);
  expect(children.map((child) => child.signal.aborted)).toEqual([true, true, true]);
});
it("startup cancellation publishes an indicator until termination and then clears it", async () => {
  const test = await manager();
  cleanups.push(test.close);
  const indicators: boolean[] = [];
  let disabled = Promise.resolve();
  test.screen.watch((state) => {
    indicators.push(state.indicator);
    if (state.lifecycle === "starting" && state.indicator) disabled = test.screen.enable(false);
  });
  await expect(ready(test.screen)).rejects.toThrow();
  await disabled;
  expect(indicators).toContain(true);
  expect(indicators.at(-1)).toBe(false);
  expect(test.screen.states()).toEqual([]);
});
