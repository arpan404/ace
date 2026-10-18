import { afterEach, expect, test } from "vitest";
import { facts, workbenchServices } from "@ace/fake-daemon";
import { commands, connect, fixture, latest, open, reset, until } from "./thread-harness.ts";

/*
 * Effort and speed on the phone's composer, over the real SDK and the fake daemon's catalog: the
 * levels its model offers, a pick that goes out with the next message only, and what a model
 * can't take refused before anything is sent. No provider CLI runs.
 */

afterEach(reset);

const model = "simulated-ultra-reasoning-extended-context-demonstration-model";
type Tune = {
  efforts: { id: string; label: string }[];
  effort: string;
  effortReason: string;
  speeds: { speed: string; label: string }[];
  speed: string;
  pending: boolean;
};
const tune = () => latest("thread.tune") as Tune | undefined;

function tunable(capabilities?: Record<string, unknown>) {
  const fake = fixture();
  fake.seedServices(workbenchServices(Date.now(), "UTC"));
  fake.createThread({
    id: "tune",
    workspaceId: "ace",
    title: "Tune",
    provider: "codex",
    execution: { provider: "codex", model, instanceId: "codex-personal", options: {} },
    ...(capabilities ? { capabilities } : {}),
  });
  fake.apply("tune", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  return fake;
}

test("a picked effort and speed go out with the next message only, then the pick is spent", async () => {
  const thread = open(connect(tunable()), "tune");
  const offered = await until(() => (tune()?.efforts.length ? tune() : undefined), "the levels");
  expect(offered.efforts.map((effort) => effort.id)).toEqual([
    "minimal",
    "low",
    "medium",
    "high",
    "ultra",
  ]);
  expect(offered.effort).toBe("medium");
  expect(offered.speeds.map((speed) => speed.speed)).toEqual(["standard", "fast", "ultrafast"]);
  thread.handle({ type: "effort", effort: "high", requestId: "e1" });
  thread.handle({ type: "speed", speed: "fast", requestId: "s1" });
  await until(() => latest("admission", "s1")?.ok, "the speed picked");
  expect(tune()).toMatchObject({ effort: "high", speed: "fast", pending: true });
  thread.handle({ type: "send", text: "Go deeper", opposite: false, requestId: "m1" });
  await until(() => commands("thread.send").length === 1, "the message");
  expect(commands("thread.send")[0]?.options).toEqual({ effort: "high", serviceTier: "priority" });
  await until(() => tune()?.pending === false, "the pick spent");
  thread.handle({ type: "send", text: "And again", opposite: false, requestId: "m2" });
  await until(() => commands("thread.send").length === 2, "the second message");
  expect(commands("thread.send")[1]?.options).not.toMatchObject({ serviceTier: "priority" });
});

test("a level the model doesn't offer, or a provider that can't change effort, is refused", async () => {
  const thread = open(connect(tunable({ sessionOptions: false })), "tune");
  const blocked = await until(() => (tune()?.efforts.length ? tune() : undefined), "the levels");
  expect(blocked.effortReason).toMatch(/only when a thread starts/);
  thread.handle({ type: "effort", effort: "high", requestId: "e1" });
  await until(() => latest("admission", "e1"), "a refusal");
  expect(latest("admission", "e1")?.ok).toBe(false);
  expect(tune()?.pending).toBe(false);
});

test("an effort outside the model's levels is refused on a provider that takes effort", async () => {
  const thread = open(connect(tunable()), "tune");
  await until(() => tune()?.efforts.length, "the levels");
  thread.handle({ type: "effort", effort: "extreme", requestId: "e1" });
  await until(() => latest("admission", "e1"), "a refusal");
  expect(latest("admission", "e1")?.ok).toBe(false);
});
