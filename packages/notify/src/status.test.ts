import { afterEach, expect, it } from "vitest";
import { setup } from "./notify.test-helper.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture() {
  const f = setup();
  fixtures.push(f);
  return f;
}

it("alerts for whole-thread completion, failure and silence from core status", async () => {
  const f = fixture();
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries.map((d) => d.notification.status)).toEqual(["done", "done"]);
  f.start();
  f.end("failed");
  await f.flush();
  expect(f.deliveries.slice(2).map((d) => d.notification.status)).toEqual(["failed", "failed"]);
  f.start();
  f.setTime(200_000);
  f.fact({ type: "tick" });
  await f.flush();
  expect(f.deliveries.slice(4).map((d) => d.notification.status)).toEqual([
    "unresponsive",
    "unresponsive",
  ]);
});
it("needs-you links to an approval without leaking its description or provider data", async () => {
  const f = fixture();
  f.start();
  const events = f.fact({
    type: "interaction.opened",
    agent: "root",
    interaction: "approval",
    blocking: true,
    request: {
      kind: "approval",
      title: "rm secret",
      description: "private prompt",
      options: [
        { id: "yes", label: "dangerous code", kind: "allow_once" },
        { id: "no", label: "secret", kind: "deny" },
      ],
    },
    raw: [{ type: "secret", data: { prompt: "private" } }],
  });
  const opened = events.find((event) => event.payload.type === "interaction.opened");
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
  expect(f.deliveries[0]?.notification).toEqual({
    id: expect.any(String),
    threadId: f.threadId,
    title: "Safe title",
    status: "needs_you",
    interactionId:
      opened?.payload.type === "interaction.opened" ? opened.payload.interaction.id : undefined,
    backgroundCount: 0,
    actions: [
      { action: "approve", optionId: "yes" },
      { action: "deny", optionId: "no" },
    ],
  });
  expect(JSON.stringify(f.deliveries)).not.toContain("private");
});
it("questions produce needs-you with no approval actions", async () => {
  const f = fixture();
  f.start();
  f.fact({
    type: "interaction.opened",
    agent: "root",
    interaction: "q",
    blocking: true,
    request: {
      kind: "question",
      questions: [
        { id: "q", text: "private question", options: [], multiSelect: false, allowOther: true },
      ],
    },
  });
  await f.flush();
  expect(f.deliveries[0]?.notification).toMatchObject({
    status: "needs_you",
    interactionId: expect.any(String),
    actions: [],
  });
});
it("an expected self-started turn cancels the transient completion alert", async () => {
  const f = fixture();
  f.start();
  f.end();
  f.fact({ type: "wake.expected", agent: "root", until: 30_000 });
  await f.flush();
  expect(f.deliveries).toEqual([]);
  f.start("background_completion");
  await f.flush();
  expect(f.deliveries).toEqual([]);
  f.end();
  await f.flush();
  expect(f.deliveries.map((d) => d.notification.status)).toEqual(["done", "done"]);
});
it("no done alert is sent while a child or nonambient background task remains live", async () => {
  const f = fixture();
  f.start();
  f.fact({
    type: "agent.seen",
    agent: "child",
    parent: "root",
    origin: "provider_subagent",
    fidelity: "full",
    native: { provider: "codex", nativeId: "child" },
    cwd: "/repo",
  });
  f.start("user", "child");
  f.end();
  await f.flush();
  expect(f.deliveries).toEqual([]);
  f.fact({
    type: "background.started",
    agent: "child",
    task: "task",
    kind: "shell",
    title: "private command",
    stoppable: true,
  });
  f.end("completed", "child");
  await f.flush();
  expect(f.deliveries).toEqual([]);
  f.fact({ type: "background.ended", task: "task", status: "completed" });
  await f.flush();
  expect(f.deliveries.map((d) => d.notification)).toEqual([
    expect.objectContaining({ status: "done", backgroundCount: 1 }),
    expect.objectContaining({ status: "done", backgroundCount: 1 }),
  ]);
});
it("bursts coalesce at the first deadline with the final status and count", async () => {
  const f = fixture();
  f.start();
  f.end();
  f.setTime(2000);
  f.start();
  f.end("failed");
  f.setTime(5999);
  await f.service.drain();
  expect(f.deliveries).toEqual([]);
  f.setTime(6000);
  await f.service.drain();
  expect(f.deliveries.map((d) => d.notification.status)).toEqual(["failed", "failed"]);
  await f.service.drain();
  expect(f.deliveries).toHaveLength(2);
});
it("background completions coalesce and duplicate terminal updates or replay do not notify again", async () => {
  const f = fixture();
  f.start();
  for (const task of ["one", "two"])
    f.fact({
      type: "background.started",
      agent: "root",
      task,
      kind: "shell",
      title: "secret",
      stoppable: true,
    });
  const first = f.fact({ type: "background.ended", task: "one", status: "completed" });
  f.fact({ type: "background.ended", task: "two", status: "completed" });
  await f.flush();
  expect(f.deliveries.map((d) => d.notification)).toEqual([
    expect.objectContaining({ status: "background_done", backgroundCount: 2 }),
    expect.objectContaining({ status: "background_done", backgroundCount: 2 }),
  ]);
  f.service.ingest(f.history);
  const update = first.find((event) => event.payload.type === "background_task.updated");
  if (!update) throw new Error("Missing task update");
  f.append([update.payload]);
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
});
it("a second interaction refreshes needs-you and closed interactions are never deep-linked", async () => {
  const f = fixture();
  f.start();
  const question = (interaction: string) =>
    f.fact({
      type: "interaction.opened",
      agent: "root",
      interaction,
      blocking: true,
      request: { kind: "question", questions: [] },
    });
  const first = question("first").find((event) => event.payload.type === "interaction.opened");
  await f.flush();
  question("second");
  if (first?.payload.type !== "interaction.opened") throw new Error("Missing interaction");
  f.fact({ type: "interaction.closed", interaction: "first", state: "resolved" });
  await f.flush();
  expect(f.deliveries).toHaveLength(4);
  expect(f.deliveries[2]?.notification.interactionId).not.toBe(first.payload.interaction.id);
});

it("large active task sets complete incrementally without losing completion counts", async () => {
  const f = fixture();
  f.start();
  for (let i = 0; i < 160; i++)
    f.fact({
      type: "background.started",
      agent: "root",
      task: `task-${i}`,
      kind: "shell",
      title: "private",
      stoppable: true,
    });
  for (let i = 0; i < 160; i++)
    f.fact({ type: "background.ended", task: `task-${i}`, status: "completed" });
  await f.flush();
  expect(f.deliveries.map((d) => d.notification)).toEqual([
    expect.objectContaining({ status: "background_done", backgroundCount: 160 }),
    expect.objectContaining({ status: "background_done", backgroundCount: 160 }),
  ]);
});
