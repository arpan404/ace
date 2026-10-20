import { once } from "node:events";
import { expect, test } from "vitest";
import { backendFixture } from "./backend-test-support.ts";

test("Chrome screencasts a page only while someone watches it or an agent drives it", async () => {
  const f = await backendFixture();
  const sent: string[] = [];
  for (const method of ["Page.startScreencast", "Page.stopScreencast", "Page.captureScreenshot"])
    f.requests.on(method, () => sent.push(method));
  await f.open();
  // Nobody watches: the page gets one seed frame and no screencast.
  expect(sent).toContain("Page.captureScreenshot");
  expect(sent).not.toContain("Page.startScreencast");

  const started = once(f.requests, "Page.startScreencast");
  const leave = f.service.subscribe("thread", "viewer", { send: () => true }, () => {});
  await started;

  // The last viewer leaves: the screencast stops once its linger passes.
  const stopped = once(f.requests, "Page.stopScreencast");
  leave();
  await stopped;

  // An unwatched agent command screencasts while it runs, then stops again.
  const resumed = once(f.requests, "Page.startScreencast");
  await f.service.execute("thread", { action: "history", direction: "stop" });
  await resumed;
  await once(f.requests, "Page.stopScreencast");
}, 20_000);
