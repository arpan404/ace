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
