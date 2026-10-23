import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, latest, open, reset, until } from "./thread-harness.ts";

/*
 * The open thread's model sheet over the real SDK and the fake daemon's catalog: the model the
 * thread runs on is always listed and marked, and a star is kept where the web keeps it.
 */

afterEach(reset);

type Models = {
  state: string;
  models: { id: string; label: string; current: boolean }[];
  favorites: string[];
};
const models = () => latest("thread.models") as Models | undefined;

function runningOn(model: string) {
  const fake = fixture();
  fake.createThread({
    id: "models",
    workspaceId: "ace",
    title: "Models",
    provider: "codex",
    execution: { provider: "codex", model, instanceId: "codex-personal", options: {} },
  });
  fake.apply("models", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  return fake;
}

test("a model the catalog doesn't list is still shown first and marked as the one in use", async () => {
  const thread = open(connect(runningOn("gpt-retired-preview")), "models");
  await until(() => latest("thread.tune"), "the thread");
  thread.handle({ type: "models" });
  const ready = await until(() => (models()?.state === "ready" ? models() : undefined), "the list");
  expect(ready.models[0]).toMatchObject({ id: "gpt-retired-preview", current: true });
  expect(ready.models.filter((row) => row.current)).toHaveLength(1);
  expect(ready.models.length).toBeGreaterThan(1);
});

test("a listed model in use is marked once, and a star on it shows under favorites", async () => {
  const thread = open(connect(runningOn("gpt-6")), "models");
  await until(() => latest("thread.tune"), "the thread");
  thread.handle({ type: "models" });
  const ready = await until(() => (models()?.state === "ready" ? models() : undefined), "the list");
  expect(ready.models.filter((row) => row.current).map((row) => row.id)).toEqual(["gpt-6"]);
  expect(ready.favorites).toEqual([]);
  thread.handle({ type: "favorite", model: "gpt-6" });
  await until(() => models()?.favorites.includes("gpt-6"), "the star saved");
  thread.handle({ type: "favorite", model: "gpt-6" });
  await until(() => models()?.favorites.length === 0, "the star removed");
});
