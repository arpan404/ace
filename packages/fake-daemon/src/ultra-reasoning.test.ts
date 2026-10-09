import { expect, test } from "vitest";
import {
  ClientMessage,
  ServerMessage,
  ThreadId,
  type ServerMessage as Message,
} from "@ace/protocol";
import { FakeDaemon } from "./daemon.ts";
import { ScenarioPlayer } from "./scenario.ts";
import { turnStatuses } from "./scenarios/turn-statuses.ts";
import { workbenchServices } from "./scenarios/services.ts";

test("the activity preview boots with an explicitly supported simulated Ultra and Fast selection", () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  for (const scenario of turnStatuses()) new ScenarioPlayer(daemon, scenario).runUntilBlocked();
  daemon.seedServices(workbenchServices(1000, "UTC"));
  const snapshot = daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("thread-ultra-reasoning-preview"),
  });
  if (snapshot?.kind !== "thread") throw new Error("Missing Ultra preview");
  expect(snapshot.thread.details).toMatchObject({
    branch: "preview/ultra",
    mode: "local",
    workspace: { path: "/Users/dev/relay" },
    machine: { host: daemon.hostId },
  });
  expect(snapshot.thread.execution).toMatchObject({
    model: "simulated-ultra-reasoning-extended-context-demonstration-model",
    instanceId: "codex-personal",
    options: { effort: "ultra", serviceTier: "priority" },
  });
  const replies: Message[] = [];
  daemon.services.handle(
    ClientMessage.parse({ type: "models.list", requestId: "models" }),
    (value) => replies.push(ServerMessage.parse(value)),
  );
  const response = replies.find((reply) => reply.type === "models.result");
  if (response?.type !== "models.result" || !("models" in response.result))
    throw new Error("Missing model catalog");
  const model = response.result.models.find(
    (row) => row.id === snapshot.thread.execution?.model && row.instance === "codex-personal",
  );
  expect(model).toMatchObject({
    displayName: "Simulated Ultra Reasoning with Extended Context Model",
    reasoningEfforts: ["minimal", "low", "medium", "high", "ultra"],
    hidden: false,
  });
  expect(model?.serviceTiers).toContainEqual(
    expect.objectContaining({ speed: "fast", parameters: { serviceTier: "priority" } }),
  );
  expect(model?.raw.json).toBe('{"simulated":true}');
});
