import { expect, test } from "vitest";
import { shutdownStage } from "./shutdown.ts";
import { Resources } from "./services/resources.ts";

test("a hung connection drain releases cleanup to close the remaining resources", async () => {
  const expired = Promise.withResolvers<() => void>();
  const held = Promise.withResolvers<void>();
  let released = false;
  const resources = new Resources();
  resources.own(() => {
    released = true;
  });
  const closing = (async () => {
    try {
      await shutdownStage(
        "connections",
        () => held.promise,
        2000,
        (_name, expire) => {
          expired.resolve(expire);
          return () => {};
        },
      );
    } finally {
      await resources.close();
    }
  })();
  const result = closing.catch((error: unknown) => error);
  (await expired.promise)();
  expect(await result).toBeInstanceOf(Error);
  expect(released).toBe(true);
  held.resolve();
});

test("completed shutdown cancels its deadline and runs resource disposers despite failures", async () => {
  let expired: (() => void) | undefined;
  const resources = new Resources();
  const released: string[] = [];
  resources.own(() => {
    released.push("store");
  });
  resources.own(() => {
    released.push("service");
    throw new Error("close failed");
  });
  await expect(
    shutdownStage(
      "resources",
      () => resources.close(),
      5000,
      (_name, expire) => {
        expired = expire;
        return () => {
          expired = undefined;
        };
      },
    ),
  ).rejects.toThrow("Daemon resource cleanup failed");
  expect(released).toEqual(["service", "store"]);
  expect(expired).toBeUndefined();
});
