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
