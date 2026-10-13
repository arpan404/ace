import { expect, test } from "vitest";
import type { Frame } from "@ace/engine-api";
import { sessionHarness } from "./session.test-helper.ts";
import { list, obj, str } from "./native.ts";

const completed = (frame: Frame) => obj(frame.data)["method"] === "turn/completed";
const appListRequests = (frames: Frame[]) =>
  frames.filter((frame) => frame.dir === "send" && obj(frame.data)["method"] === "app/list").length;
const appCatalogs = (frames: Frame[]) =>
  frames
    .filter(
      (frame) => frame.channel === "catalog.runtime" && obj(frame.data)["method"] === "app/list",
    )
    .map((frame) => list(obj(obj(frame.data)["result"])["data"]).map((app) => str(obj(app)["id"])));

test("an idle session stops exchanging catalog messages when Codex echoes app/list/updated after every read", async () => {
  const h = await sessionHarness(false, "app-list-echo");
  try {
    await h.wait((frame) => appCatalogs([frame]).length > 0);
    await h.session.send([{ type: "text", text: "first" }], "queue");
    await h.wait(completed);
    // A simulated idle minute: every owned timer fires, then a full stdio round trip proves
    // the pipe has drained everything Codex wrote in reaction to earlier reads.
    for (let tick = 0; tick < 60; tick++) h.runTimers();
    await h.session.send([{ type: "text", text: "barrier" }], "queue");
    await h.wait((frame) => completed(frame) && h.frames.filter(completed).length === 2);
    expect(appListRequests(h.frames)).toBe(1);
    expect(appCatalogs(h.frames)).toEqual([["calendar"]]);
  } finally {
    await h.dispose();
  }
}, 5000);

test("a changed Codex app list is published from its notification without another read", async () => {
  const h = await sessionHarness(false, "app-list-echo");
  try {
    await h.wait((frame) => appCatalogs([frame]).length > 0);
    await h.session.send([{ type: "text", text: "connect drive" }], "queue");
    await h.wait(completed);
    expect(appCatalogs(h.frames)).toEqual([["calendar"], ["calendar", "drive"]]);
    expect(appListRequests(h.frames)).toBe(1);
  } finally {
    await h.dispose();
  }
}, 5000);
