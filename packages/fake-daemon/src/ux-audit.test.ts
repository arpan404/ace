import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { FakeDaemon, ScenarioPlayer, uxAudit } from "./index.ts";

function world() {
  let now = 0;
  const daemon = new FakeDaemon({ clock: () => ++now });
  const players = uxAudit().map((script) => new ScenarioPlayer(daemon, script));
  for (const player of players) player.runUntilBlocked();
  return { daemon, players };
}
function thread(daemon: FakeDaemon, id: string) {
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) });
  if (view?.kind !== "thread") throw new Error("Expected thread");
  return view;
}

test("Codex's steered answer stays linked to the original question in history", () => {
  const { daemon } = world();
  const view = thread(daemon, "thread-ux-question-steer-answered");
  const interaction = Object.values(view.interactions).find(
    (value) => value.request.kind === "question",
  );
  expect(interaction).toMatchObject({
    state: "resolved",
    resolution: { kind: "question", answers: { indent: ["tabs"] } },
  });
  const echo = Object.values(view.items).find(
    (item) => item.type === "message" && item.origin?.kind === "interaction_answer",
  );
  expect(echo).toMatchObject({
    origin: { kind: "interaction_answer", interactionId: interaction?.id },
    synthetic: true,
    parts: [{ type: "text", text: "Tabs" }],
  });
});

test("audit scenarios retain terminal failures, stops, handoff and the pending permission state", () => {
  const { daemon } = world();
  expect(thread(daemon, "thread-ux-auth-error").thread.status.state).toBe("failed");
  expect(Object.values(thread(daemon, "thread-ux-interrupted").runs)).toMatchObject([
    { state: "interrupted" },
  ]);
  const child = thread(daemon, "thread-ux-delegated-model-error");
  expect(child.thread.status.state).toBe("failed");
  expect(
    Object.values(child.items).filter((item) => item.type === "notice" && item.level === "error"),
  ).toHaveLength(1);
  expect(
    Object.values(child.items).filter((item) => item.type === "message" && item.role === "user"),
  ).toMatchObject([
    {
      origin: { kind: "spawn", parentThreadId: "thread-ux-delegation-results" },
      parts: [{ type: "text", text: "Role: greeter\n\nTask:\nWrite a short welcome message." }],
    },
  ]);
  const switched = thread(daemon, "thread-ux-switch-handoff");
  expect(switched.thread.switch).toMatchObject({ state: "applied", lossy: true });
  expect(Object.values(switched.items)).toContainEqual(
    expect.objectContaining({ origin: expect.objectContaining({ kind: "handoff" }) }),
  );
  expect(thread(daemon, "thread-ux-pending-full-access").thread.permission).toMatchObject({
    effective: "auto-review",
    override: "full-access",
    pending: true,
  });
});

test("admission preserves the original input under its command id and retries never add a bubble", () => {
  let now = 0;
  const daemon = new FakeDaemon({ clock: () => ++now });
  const create = Command.parse({
    id: "create-input",
    deviceId: "device",
    payload: {
      type: "thread.create",
      workspaceId: "relay",
      provider: "claude",
      input: [
        { type: "text", text: "Keep the original attachment\nwith its details" },
        { type: "image", mimeType: "image/png", url: "data:image/png;base64,AA==" },
      ],
    },
  });
  const created = daemon.command(create);
  expect(daemon.command(create)).toEqual(created);
  const view = thread(daemon, "thread-create-input");
  // Like the daemon, the provisional title is the request's first line.
  expect(view.thread.title).toBe("Keep the original attachment");
  expect(
    Object.values(view.items).filter((item) => item.type === "message" && item.role === "user"),
  ).toMatchObject([
    {
      id: "input:create-input",
      type: "message",
      origin: { kind: "person", commandId: "create-input" },
      parts: create.payload.type === "thread.create" ? create.payload.input : [],
    },
  ]);
  const send = Command.parse({
    id: "queued-input",
    deviceId: "device",
    payload: {
      type: "thread.send",
      threadId: "thread-create-input",
      delivery: "queue",
      input: [{ type: "text", text: "A queued follow-up" }],
    },
  });
  expect(daemon.command(send)).toMatchObject({ ok: true });
  expect(daemon.command(send)).toMatchObject({ ok: true });
  const queued = () =>
    Object.values(thread(daemon, "thread-create-input").items).filter(
      (item) => item.id === "input:queued-input",
    );
  // Admitted at once, like the daemon; the run that later delivers it takes it as its own.
  expect(queued()).toMatchObject([{ origin: { kind: "person", commandId: "queued-input" } }]);
  const firstRun = queued()[0]?.runId;
  daemon.apply("thread-create-input", [
    { type: "turn.ended", agent: "root", outcome: "completed" },
  ]);
  expect(queued()).toHaveLength(1);
  expect(queued()[0]?.runId).toEqual(expect.any(String));
  expect(queued()[0]?.runId).not.toBe(firstRun);
});
