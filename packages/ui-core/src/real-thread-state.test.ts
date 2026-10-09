import { CatalogModel } from "@ace/protocol";
import { resolveModel } from "@ace/models/resolve";
import { expect, test } from "vitest";
import { modelReplacement, unavailableSelection } from "./model-availability.ts";
import { queueNotice } from "./queue.ts";

const row = (id: string) =>
  CatalogModel.parse({
    id,
    provider: "opencode",
    instance: "personal",
    displayName: "Muse Spark 1.3 Contributor",
    nativeModelId: id,
    nativeProviderId: "opencode-go",
    reasoningEfforts: [],
    serviceTiers: [],
    inputModalities: ["text"],
    isDefault: true,
    hidden: false,
    deprecated: false,
    raw: { json: "{}", truncated: false },
  });
const selection = { provider: "opencode" as const, model: "muse-spark-1.3-contributor" };
test("old bare OpenCode selections still run their provider-qualified model", () => {
  const models = [row("opencode-go/muse-spark-1.3-contributor")];
  expect(resolveModel({ role: "thread", ...selection }, models, () => false)).toMatchObject({
    ok: true,
    model: { id: models[0]?.id },
  });
  expect(unavailableSelection(models, selection)).toBeUndefined();
});
test("a rejected model is never offered again through another route with the same name", () => {
  const models = [
    row("opencode-go/muse-spark-1.3-contributor"),
    row("copilot/muse-spark-1.3-contributor"),
  ];
  expect(modelReplacement(models, selection)).toBeUndefined();
});
test("an empty manual queue hold does not ask the person to resume nothing", () => {
  expect(
    queueNotice({ state: "done" }, { paused: true, reason: "manual", resumeAt: null }, 0),
  ).toBeUndefined();
});

test("an ambiguous bare OpenCode model asks for a provider route rather than silently changing provider", () => {
  const models = [
    row("opencode-go/muse-spark-1.3-contributor"),
    row("copilot/muse-spark-1.3-contributor"),
  ];
  expect(resolveModel({ role: "thread", ...selection }, models, () => false)).toMatchObject({
    ok: false,
  });
  expect(unavailableSelection(models, selection)).toMatchObject({ model: selection.model });
});
