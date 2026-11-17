import { expect, it } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";
import { ownClose, setup } from "./testing/v2-session.ts";

it("an account whose server stop failed opens again on a fresh server once the old one is gone", async () => {
  let survivors = true;
  let spawned = 0;
  // An OpenCode server whose tree outlives its stop until the test lets the survivors exit.
  const spawn: typeof spawnSupervised = (options) => {
    spawned++;
    const proc = spawnSupervised(options);
    return {
      ...proc,
      stop: (stop) =>
        proc.stop(stop).then((exit) => {
          if (survivors) throw new Error("Windows process tree survived its stop");
          return exit;
        }),
    };
  };
  const h = await setup({ runtime: { spawn } });
  ownClose(h.adapter);
  await expect(h.session.close("user")).rejects.toThrow("survived its stop");
  // Still running: the next open says so, and starts nothing beside it.
  await expect(h.open()).rejects.toThrow(
    "previous OpenCode server for this account is still running",
  );
  expect(spawned).toBe(1);
  // The survivors exit; the next open confirms that and starts a fresh server.
  survivors = false;
  const session = await h.open();
  expect(spawned).toBe(2);
  await session.close("user");
  await h.adapter.close();
});
