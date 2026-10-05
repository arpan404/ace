import { expect, test } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { harness, poll } from "./account-management-test-support.ts";

// Guards mutation 21: disconnect must prevent launch even when a fence finishes successfully.
test("disconnect while Cursor fencing prevents the SDK auth helper from launching", async () => {
  const fencing = Promise.withResolvers<void>();
  const releaseFence = Promise.withResolvers<void>();
  let launched = "";
  const f = await harness(false, {
    cursor: () => ({
      env: {},
      busy: () => false,
      fence: async () => {
        fencing.resolve();
        await releaseFence.promise;
      },
      rebind: async () => {},
      status: async () => "logged_out",
    }),
    terminal: {
      dependencies: {
        backendFactory: (options) => {
          launched = join(options.cwd, "fixture-sdk-launched");
          writeFileSync(launched, "unexpected SDK helper launch");
          throw new Error("Cancelled helper must not launch");
        },
      },
    },
  });
  try {
    const account = await f.add("cursor");
    const auth = await f.request(f.owner, {
      type: "accounts.login",
      requestId: f.rid(),
      instanceId: account.id,
    });
    if (auth.type !== "accounts.auth") throw new Error("Missing terminal");
    f.owner.send({
      type: "terminal.request",
      requestId: f.rid(),
      operation: {
        op: "subscribe",
        terminalId: auth.terminalId,
        subscriptionId: "fenced",
        fromOffset: 0,
      },
    });
    expect(await f.owner.next()).toMatchObject({ type: "terminal.result", ok: true });
    await fencing.promise;
    const other = await f.connect();
    await other.next();
    await f.owner.close();
    // Drain the server's close event before releasing the asynchronous fence.
    await setImmediate();
    expect(
      await f.request(other, {
        type: "accounts.remove",
        requestId: f.rid(),
        instanceId: account.id,
        deleteHome: true,
      }),
    ).toMatchObject({ type: "error", code: "accounts_failed" });
    releaseFence.resolve();
    await poll(() => f.accounts.isChangingAccount(account.id)).toBe(false);
    expect(existsSync(join(f.dataDir, "account-homes", account.id, "fixture-sdk-launched"))).toBe(
      false,
    );
    expect(launched).toBe("");
  } finally {
    releaseFence.resolve();
    await f.close();
  }
});
