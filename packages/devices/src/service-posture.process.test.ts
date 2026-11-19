import { expect, it } from "vitest";
import type { DevicePosture } from "@ace/protocol/devices";
import { bind, harness } from "./service-test-support.ts";

it("a foldable device whose first fold read found nothing gains its posture on a later inventory read", async () => {
  const h = await harness();
  // The first read comes while the device is still booting and finds no fold; later ones do.
  let foldable = false;
  h.platform.posture = async (): Promise<DevicePosture | undefined> =>
    foldable ? "open" : undefined;
  await bind(h);
  await h.service.list();
  expect(h.service.states()[0]?.posture).toBeUndefined();

  foldable = true;
  const seen: (DevicePosture | undefined)[] = [];
  const stop = h.service.watch((state) => seen.push(state.posture));
  await h.service.list();
  await new Promise((resolve) => setImmediate(resolve));
  stop();

  expect(h.service.states()[0]?.posture).toBe("open");
  expect(seen).toContain("open");
});
