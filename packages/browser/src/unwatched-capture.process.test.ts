import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { backendFixture } from "./backend-test-support.ts";

test("Chrome screencasts JPEG only while an agent drives the page, never for a viewer", async () => {
  const f = await backendFixture();
  const sent: string[] = [];
  for (const method of ["Page.startScreencast", "Page.stopScreencast", "Page.captureScreenshot"])
    f.requests.on(method, () => sent.push(method));
  await f.open();
  // Nothing records and nobody drives the page: one tiny screenshot proves it draws, and no
  // screencast runs.
  expect(sent).toEqual(["Page.captureScreenshot"]);

  // A viewer watches video; the JPEG screencast stays off.
  const leave = f.service.subscribe("thread", "viewer", {}, () => {});
  await sleep(300);
  expect(sent).not.toContain("Page.startScreencast");
  leave();

  // An agent command screencasts while it runs, then stops again.
  const resumed = once(f.requests, "Page.startScreencast");
  await f.service.execute("thread", { action: "history", direction: "stop" });
  await resumed;
  await once(f.requests, "Page.stopScreencast");
}, 20_000);
