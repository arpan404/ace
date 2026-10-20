import { afterEach, expect, it } from "vitest";
import { groupViews } from "./test-support.ts";
import { connectDesktop, eventually, relayDaemon } from "./relay-test-support.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

it("a desktop whose computer wakes tells the daemon, so it checks its browsers (#947)", async () => {
  const received: unknown[] = [];
  const daemon = await relayDaemon(cleanups, { received: (message) => received.push(message) });
  const { connection } = await connectDesktop(cleanups, daemon, groupViews().host);
  expect(received).not.toContainEqual({ type: "browser.backend.resumed" });
  // What powerMonitor's resume does through the app's background link.
  connection.wake();
  await eventually(() => expect(received).toContainEqual({ type: "browser.backend.resumed" }));
  expect(connection.state()).toBe("registered");
});

it("a desktop whose screen locks and unlocks tells the daemon once per change", async () => {
  const received: unknown[] = [];
  const daemon = await relayDaemon(cleanups, { received: (message) => received.push(message) });
  const { connection } = await connectDesktop(cleanups, daemon, groupViews().host);
  const notices = () =>
    received.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "browser.backend.drawable",
    );
  // What powerMonitor's lock-screen and unlock-screen do through the app's background link.
  connection.setDrawable(false);
  connection.setDrawable(false);
  await eventually(() =>
    expect(notices()).toEqual([{ type: "browser.backend.drawable", drawable: false }]),
  );
  connection.setDrawable(true);
  await eventually(() =>
    expect(notices()).toEqual([
      { type: "browser.backend.drawable", drawable: false },
      { type: "browser.backend.drawable", drawable: true },
    ]),
  );
  expect(connection.state()).toBe("registered");
});
