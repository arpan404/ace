import { afterEach, expect, it, vi } from "vitest";
import { alert, closePhones, phone } from "./notifications-fixture.ts";

afterEach(closePhones);

/** The fixture client's device id, as the daemon knows it. */
const device = "phone";

it("a live alert is acknowledged before Swift sees it", async () => {
  const { daemon, sync, of, interactions, watch } = await phone();
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  // What the daemon had heard back when Swift got each alert.
  const ackedWhenShown: string[][] = [];
  watch((patch) => {
    if (patch.type === "notifications.alert")
      ackedWhenShown.push(daemon.notifications.acknowledged(device));
  });
  // A needs-you alert reads its request from the thread before Swift sees it.
  daemon.notify({ ...alert("n:asks"), status: "needs_you", interactionId: interactions()[0]?.id });
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  expect(ackedWhenShown).toEqual([["n:asks"]]);
});

it("a live alert is acknowledged while this machine's alerts are muted, and Swift isn't told", async () => {
  const { daemon, sync, settle, of } = await phone();
  sync(false);
  await settle();
  // The phone is awake and took the frame; acking stops the daemon pushing it to a muted phone.
  daemon.notify(alert("n:muted"));
  await vi.waitFor(() => expect(daemon.notifications.acknowledged(device)).toEqual(["n:muted"]));
  await settle();
  expect(of("notifications.alert")).toEqual([]);
});
