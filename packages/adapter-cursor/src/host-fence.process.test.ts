import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { runtimeFixture } from "./host-runtime-test-support.ts";

const storageFailed = () => Promise.reject(new Error("database is locked"));
/** "cancelled" once the SDK run is cancelled, or "still running" after `ms`. */
const cancelledWithin = (reached: Promise<void>, ms: number) =>
  Promise.race([reached.then(() => "cancelled"), sleep(ms).then(() => "still running")]);

// The run was admitted, but ace could not record that it exists, nor the fence notice.
it("a run admitted before its segment frame could be stored is cancelled even when the fence notice cannot be stored", async () => {
  await using fixture = await runtimeFixture({}, (frame) =>
    frame.kind === "segment" || frame.kind === "error" ? storageFailed() : Promise.resolve(),
  );
  await fixture.open();
  await expect(fixture.send("first")).rejects.toThrow();
  expect(await cancelledWithin(fixture.reached("sdk-cancel"), 2000)).toBe("cancelled");
});

it("a turn fenced while streaming is cancelled without waiting for its fence notice to be stored", async () => {
  await using fixture = await runtimeFixture({ ackTimeoutMs: 4000 }, (frame) =>
    frame.kind === "message"
      ? storageFailed()
      : frame.kind === "error"
        ? sleep(6000)
        : Promise.resolve(),
  );
  await fixture.open();
  await expect(fixture.send("first")).resolves.toEqual({ runId: "run" });
  expect(await cancelledWithin(fixture.reached("sdk-cancel"), 1500)).toBe("cancelled");
});
