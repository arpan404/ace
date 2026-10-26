import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { commands, connect, fixture, latest, open, reset, until } from "./thread-harness.ts";

/*
 * The thread composer's access control over the real SDK and the fake daemon: the mode in
 * effect, the modes the provider supports, and a change that waits for the agent's next turn.
 */

afterEach(reset);

type Access = {
  state: string;
  label: string;
  selected: string | null;
  pending: boolean;
  choices: { mode: string; label: string; attention: boolean }[];
};
const access = () => latest("thread.access") as Access | undefined;

function onAsk() {
  const fake = fixture();
  fake.createThread({
    id: "access",
    workspaceId: "ace",
    title: "Access",
    provider: "codex",
    access: "ask",
    execution: { provider: "codex", model: "gpt-6", instanceId: "codex-personal", options: {} },
  });
  fake.apply("access", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  return fake;
}

test("the thread's access names its mode and offers its provider's modes, Full access marked", async () => {
  open(connect(onAsk()), "access");
  const shown = await until(() => (access()?.state === "ready" ? access() : undefined), "access");
  expect(shown).toMatchObject({ label: "Ask", selected: "ask", pending: false });
  expect(shown.choices.find((choice) => choice.mode === "full-access")?.attention).toBe(true);
  expect(shown.choices.filter((choice) => choice.attention).map((choice) => choice.mode)).toEqual([
    "full-access",
  ]);
});

test("a new mode shows at once as waiting for the next turn and goes out as a durable command", async () => {
  const thread = open(connect(onAsk()), "access");
  await until(() => access()?.state === "ready", "access");
  thread.handle({ type: "access", mode: "read-only", requestId: "a1" });
  const picked = await until(
    () => (access()?.selected === "read-only" ? access() : undefined),
    "the pick",
  );
  expect(picked).toMatchObject({ pending: true, label: "Read-only" });
  await until(() => latest("admission", "a1")?.ok, "the change admitted");
  expect(commands("thread.permission.set")[0]).toMatchObject({ access: "read-only" });
  await until(() => access()?.selected === "read-only" && access()?.pending, "still waiting");
});
