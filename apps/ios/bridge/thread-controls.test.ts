import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { ClientCore } from "@ace/client";
import {
  commands,
  connect,
  fixture,
  native,
  open,
  reset,
  slowSettings,
  until,
} from "./thread-harness.ts";

/*
 * The composer's delivery follows the thread's follow-up setting from the first controls native
 * sees, and a message sent the moment the thread opens goes the way that setting says, even when
 * the setting answers after the thread's snapshot. Over the real SDK and the fake daemon.
 */

afterEach(reset);

async function steeringThread(): Promise<ClientCore> {
  const fake = fixture();
  fake.createThread({ id: "busy", workspaceId: "ace", title: "Busy", provider: "codex" });
  fake.apply("busy", [facts.rootAgent("codex"), facts.turn("root")]);
  fake.apply("busy", [facts.message("root", "ask", "user", "Fix the build.")]);
  const client = connect(fake);
  const state = client.connectionState();
  await until(() => state.getSnapshot() === "ready", "the connection");
  await client.request({
    type: "settings.set",
    key: "threads.followUpBehavior",
    value: "steer",
    layer: { kind: "global" },
  });
  // From here the setting answers after the thread's snapshot has gone to native.
  slowSettings.ms = 200;
  return client;
}

test("the first composer controls a working thread shows already follow its setting", async () => {
  open(await steeringThread(), "busy");
  const first = await until(
    () => native.frames.find((frame) => frame.type === "thread.controls"),
    "composer controls",
  );
  expect(first.row).toMatchObject({ busy: true, delivery: "steer", alternate: "queue" });
});

test("a message sent as the thread opens waits for the setting and goes as it says", async () => {
  const session = open(await steeringThread(), "busy");
  session.handle({ type: "send", text: "Also run lint", opposite: false, requestId: "now" });
  const sent = await until(() => commands("thread.send")[0], "the send");
  expect(sent.delivery).toBe("steer");
});

test("a guest session's controls say whose work it is, and Stop ends it while it runs", async () => {
  const fake = fixture();
  fake.createThread({
    id: "guest",
    workspaceId: "relay",
    provider: "claude",
    title: "Linux box · Fix the login flow",
    details: { guest: { host: "linux-box", name: "Linux box" } },
  });
  fake.apply("guest", [
    facts.rootAgent("claude"),
    {
      type: "background.started",
      owner: "ace",
      agent: "root",
      task: "ace-guest:1",
      kind: "other",
      title: "screen_act from Linux box",
      stoppable: true,
    },
  ]);
  const session = open(connect(fake), "guest");
  const controls = await until(
    () => native.frames.findLast((frame) => frame.type === "thread.controls")?.row,
    "composer controls",
  );
  expect(controls).toMatchObject({
    guest: { line: "Used by agents on Linux box. Stop to end their work." },
    canStop: true,
  });
  session.handle({ type: "stop", requestId: "stop" });
  await until(() => commands("thread.interrupt").length === 1, "the stop");
  expect(commands("thread.interrupt")[0]).toMatchObject({ threadId: "guest", cascade: true });
});

test("a thread the person talks to has no guest line", async () => {
  const fake = fixture();
  fake.createThread({ id: "own", workspaceId: "ace", title: "Own", provider: "codex" });
  fake.apply("own", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  open(connect(fake), "own");
  const controls = await until(
    () => native.frames.findLast((frame) => frame.type === "thread.controls")?.row,
    "composer controls",
  );
  expect(controls).toMatchObject({ guest: null });
});
