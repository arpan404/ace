import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import {
  commands,
  connect,
  fixture,
  latest,
  native,
  open,
  pump,
  reset,
  until,
} from "./thread-harness.ts";
import { closedThread, routeThreadAction } from "./thread-route.ts";
import { preview } from "./presentation.ts";
import { Sheets } from "./sheets.ts";

/*
 * Thread-screen actions that arrive after the person left the thread: SwiftUI releases a log or
 * a lane on disappear, which lands once the session is gone or another generation is open.
 * Real SDK, production pump and session, in-process fake daemon (`thread-harness.ts`).
 */

afterEach(reset);
const put = (key: string, read: () => Record<string, unknown>) => pump.put(key, read);
const send = (requestId: string) => ({ type: "send", text: "Go on", opposite: false, requestId });

function daemon() {
  const fake = fixture();
  fake.createThread({ id: "left", workspaceId: "ace", title: "Left", provider: "codex" });
  fake.apply("left", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Read the queue."),
    facts.endTurn("root"),
  ]);
  return fake;
}

test("closing a log or lane after leaving the thread raises no error for the inbox", async () => {
  const session = open(connect(daemon()), "left");
  await until(() => latest("thread.controls"), "the open thread");
  session.dispose();
  routeThreadAction(undefined, 1, { type: "steps.close", ordinal: 0 }, put);
  routeThreadAction(undefined, undefined, { type: "lane.close" }, put);
  routeThreadAction(undefined, 1, { type: "loadOlder" }, put);
  // A send submitted on the closed screen answers on its own admission, after the releases.
  routeThreadAction(undefined, 1, { type: "stop", requestId: "late-stop" }, put);
  const refused = await until(() => latest("admission", "late-stop"), "the refused stop");
  expect(refused).toMatchObject({ ok: false, message: closedThread });
  expect(native.frames.filter((frame) => frame.type === "error")).toEqual([]);
});

test("an action sent for an earlier generation never reaches the thread open now", async () => {
  const session = open(connect(daemon()), "left");
  await until(() => latest("thread.controls"), "the open thread");
  routeThreadAction(session, 0, send("stale-send"), put);
  routeThreadAction(session, 1, send("open-send"), put);
  await until(() => latest("admission", "open-send")?.ok === true, "the open send's admission");
  await until(() => commands("thread.send").length > 0, "the open send");
  expect(latest("admission", "stale-send")).toMatchObject({ ok: false, message: closedThread });
  expect(commands("thread.send")).toHaveLength(1);
});

test("a sheet closing after its thread was left succeeds, while opening one still needs a thread", () => {
  const sheets = new Sheets(pump, preview);
  expect(sheets.action(undefined, { kind: "agents", open: false })).toBe(true);
  expect(sheets.action(undefined, { kind: "changes", open: false })).toBe(true);
  expect(sheets.action(undefined, { kind: "changes.file", path: null })).toBe(true);
  expect(sheets.action(undefined, { kind: "agents", open: true })).toBe(false);
  expect(sheets.action(undefined, { kind: "changes.refresh" })).toBe(false);
});
