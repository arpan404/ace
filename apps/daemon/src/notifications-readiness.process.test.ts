import { DeviceId } from "@ace/protocol";
import { expect, it } from "vitest";
import { createDaemonNotifications } from "./notifications.ts";
import { fixture } from "./socket-test-support.ts";

it("notification readiness finishes while an offline push is still waiting for delivery", async () => {
  const f = await fixture();
  let announceDelivery: (() => void) | undefined;
  const delivery = new Promise<void>((resolve) => {
    announceDelivery = resolve;
  });
  const notifications = createDaemonNotifications(
    f.home,
    f.store,
    () => {},
    {
      apns: {
        send(_device, _notification, signal) {
          announceDelivery?.();
          return new Promise((resolve) => {
            const abort = () => resolve("retry");
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        },
      },
    },
    0,
  );
  let ready = false;
  let starting: Promise<void> | undefined;
  try {
    await notifications.service.register(DeviceId.parse("offline-phone"), {
      channel: "apns",
      platform: "phone",
      token: "ab".repeat(32),
    });
    f.store.appendEvents(
      f.thread.id,
      [{ type: "thread.updated", status: { state: "done" } }],
      Date.now() - 6000,
    );
    starting = notifications.start().then(() => {
      ready = true;
    });
    void starting.catch(() => {});
    await delivery;
    // The real worker announced delivery in a later message turn. Readiness must
    // already be complete while transport acceptance remains pending.
    expect(ready).toBe(true);
    await starting;
    expect(await notifications.service.cursor()).toBe(f.store.headSeq());
  } finally {
    await notifications.close();
    await starting?.catch(() => {});
    await f.close();
  }
});
