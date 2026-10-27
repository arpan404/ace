import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { commands, connect, fixture, latest, open, reset, until } from "./thread-harness.ts";

afterEach(reset);

interface Strip {
  kind: string;
  sentence: string;
  actions: { id: string; label: string; primary: boolean }[];
}
interface Queue {
  label: string;
  messages: { id: string; text: string }[];
  more: number;
  control: { id: string; label: string } | null;
  strip: Strip | null;
  notSent: { id: string; text: string; reason: string; detail: string } | null;
}
const queue = () => latest("thread.queue") as Queue | undefined;

function busyThread(id: string) {
  const fake = fixture();
  fake.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
  fake.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  return fake;
}

test("the queue offers Pause while messages wait, and Resume once the person paused it", async () => {
  const fake = busyThread("pausing");
  const thread = open(connect(fake), "pausing");
  await until(() => (latest("thread.controls")?.row as { busy?: boolean })?.busy, "a busy thread");
  thread.handle({ type: "send", text: "Then run lint", opposite: false, requestId: "q1" });
  await until(() => queue()?.control?.label === "Pause queue", "Pause on the queue");
  thread.handle({ type: "queueAct", action: { id: "hold", label: "" }, requestId: "p1" });
  await until(() => queue()?.control?.label === "Resume queue", "Resume after the pause");
  expect(commands("queue.pause")).toHaveLength(1);
  // A paused queue is one sentence above the composer, with its way out.
  expect(queue()?.strip).toMatchObject({
    sentence: "Queue paused",
    actions: [{ id: "resume", label: "Resume", primary: true }],
  });
  thread.handle({ type: "queueAct", action: { id: "resume", label: "" }, requestId: "p2" });
  await until(() => queue()?.control?.label === "Pause queue", "the queue flowing again");
  expect(queue()?.strip).toBeNull();
  expect(commands("queue.resume")).toHaveLength(1);
});

test("a long queue lists a page at a time, and Show more lists the rest to act on", async () => {
  const fake = busyThread("long");
  const thread = open(connect(fake), "long");
  await until(() => (latest("thread.controls")?.row as { busy?: boolean })?.busy, "a busy thread");
  for (let at = 0; at < 40; at++)
    thread.handle({ type: "send", text: `Step ${at}`, opposite: false, requestId: `s${at}` });
  await until(() => queue()?.more === 8, "eight past the first page");
  expect(queue()?.messages).toHaveLength(32);
  thread.handle({ type: "queueMore" });
  await until(() => queue()?.messages.length === 40, "every message listed");
  expect(queue()?.more).toBe(0);
  const last = queue()?.messages.at(-1);
  expect(last?.text).toBe("Step 39");
  thread.handle({
    type: "queue",
    messageId: String(last?.id),
    change: { kind: "remove" },
    requestId: "r1",
  });
  await until(() => queue()?.messages.length === 39, "the last one removed");
});

test("a message that wasn't sent leaves the queue's list for the transcript, with its reason", async () => {
  const fake = busyThread("unsent");
  const thread = open(connect(fake), "unsent");
  await until(() => (latest("thread.controls")?.row as { busy?: boolean })?.busy, "a busy thread");
  thread.handle({ type: "send", text: "Ship it", opposite: false, requestId: "q1" });
  thread.handle({ type: "send", text: "Then tag it", opposite: false, requestId: "q2" });
  await until(() => queue()?.messages.length === 2, "two queued");
  fake.holdQueue("unsent", "not_sent", {
    title: "Codex couldn't start. The CLI exited with code 1.",
    code: "session_start_failed",
  });
  await until(() => queue()?.notSent, "the message that wasn't sent");
  expect(queue()?.notSent).toMatchObject({ text: "Ship it", reason: "Codex couldn't start" });
  expect(queue()?.messages.map((message) => message.text)).toEqual(["Then tag it"]);
  expect(queue()?.label).toBe("1 queued message");
  // The transcript says it; the strip above the composer doesn't repeat it.
  expect(queue()?.strip).toBeNull();
  thread.handle({ type: "queueAct", action: { id: "resume", label: "" }, requestId: "t1" });
  await until(() => commands("queue.resume").length === 1, "Try again on the wire");
});

test("a usage limit holds the turn with Switch, Resume at reset and Continue", async () => {
  const resetsAt = Date.now() + 3 * 60 * 60 * 1000;
  const fake = busyThread("limited");
  fake.apply("limited", [
    { type: "retry", agent: "root", on: "rate_limit", until: resetsAt, message: "Usage limit" },
  ]);
  const thread = open(connect(fake), "limited");
  await until(() => queue()?.strip?.kind === "limit", "the limit strip");
  const strip = queue()?.strip;
  expect(strip?.sentence).toMatch(/^Codex is out of usage until /);
  expect(strip?.actions.map((action) => action.label)).toEqual([
    "Switch",
    "Resume at reset",
    "Continue",
  ]);
  expect(strip?.actions.find((action) => action.primary)?.label).toBe("Continue");
  thread.handle({
    type: "queueAct",
    action: { id: "resume_at_reset", label: "" },
    requestId: "l1",
  });
  await until(
    () => commands("thread.limit").some((payload) => payload.action === "resume_at_reset"),
    "Resume at reset on the wire",
  );
  await until(() => queue()?.strip?.sentence.includes("resumes"), "the chosen resume said");
});
