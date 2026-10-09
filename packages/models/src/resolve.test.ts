import { expect, test } from "vitest";
import { normalizeCodex, resolveModel } from "./index.ts";
import { codexPayload, instance } from "./testing/support.ts";
import { resolveEffort } from "./resolve.ts";

test("effort presets preserve explicit and catalog choices and otherwise use only supported levels", () => {
  const levels = ["low", "medium", "high"];
  expect(resolveEffort(levels, "low", "high")).toBe("low");
  expect(resolveEffort(levels, undefined, "high")).toBe("high");
  expect(resolveEffort(levels, undefined, "missing")).toBe("medium");
  expect(resolveEffort(["brief", "balanced", "deep", "extreme"])).toBe("balanced");
  expect(resolveEffort(["high"])).toBe("high");
  expect(resolveEffort([])).toBeUndefined();
});
const rows = [
  ...normalizeCodex(codexPayload("normal"), instance()),
  ...normalizeCodex(codexPayload("stronger", false), instance()),
];
test("strongest role picks its highest available preference and native fast tier", () => {
  const result = resolveModel(
    {
      role: "coder",
      provider: "codex",
      selection: "strongest",
      preferenceOrder: ["not-available", "stronger", "normal"],
      tier: "fast",
      effort: "high",
      imageInput: true,
    },
    rows,
    () => false,
  );
  expect(result).toMatchObject({
    ok: true,
    model: { id: "stronger" },
    tier: { id: "priority", parameters: { serviceTier: "priority" } },
    effort: "high",
    stale: false,
  });
  expect(result.reason).toContain("highest available policy preference");
});
test("default role preserves the provider default effort and tier", () => {
  expect(resolveModel({ role: "planner" }, rows.toReversed(), () => true)).toMatchObject({
    ok: true,
    model: { id: "normal" },
    tier: { id: "priority" },
    effort: "high",
    stale: true,
  });
});
test("strength without a policy order states the default fallback", () => {
  const result = resolveModel(
    { role: "coder", selection: "strongest" },
    rows.toReversed(),
    () => false,
  );
  expect(result).toMatchObject({ ok: true, model: { id: "normal" } });
  expect(result.reason).toContain("strength order unavailable");
});
test("unavailable explicit model and unsupported parameters never silently fall back", () => {
  for (const spec of [
    { model: "missing" },
    { effort: "max" },
    { tier: "flex" },
    { provider: "claude" as const },
    { instance: "other" },
  ]) {
    expect(resolveModel({ role: "coder", ...spec }, rows, () => false).ok).toBe(false);
  }
});
for (const flag of ["hidden", "deprecated"] as const) {
  test(`automatic policies skip ${flag} choices even if preferred`, () => {
    const unavailable = rows.map((model) =>
      model.id === "stronger" ? { ...model, [flag]: true } : model,
    );
    expect(
      resolveModel(
        { role: "coder", selection: "strongest", preferenceOrder: ["stronger", "normal"] },
        unavailable,
        () => false,
      ),
    ).toMatchObject({ ok: true, model: { id: "normal" } });
    expect(
      resolveModel({ role: "coder", model: "stronger" }, unavailable, () => false),
    ).toMatchObject({ ok: true, model: { id: "stronger" } });
  });
}
test("image requirement excludes models with unknown image support", () => {
  const unknown = rows.map((model) => Object.assign({}, model, { inputModalities: [] }));
  expect(resolveModel({ role: "vision", imageInput: true }, unknown, () => false).ok).toBe(false);
});
test("explicit canonical ID resolves to the provider's advertised alias", () => {
  const aliases = rows.map((model) =>
    Object.assign({}, model, { resolvedModelId: `canonical-${model.id}` }),
  );
  expect(
    resolveModel({ role: "coder", model: "canonical-stronger" }, aliases, () => false),
  ).toMatchObject({ ok: true, model: { id: "stronger", nativeModelId: "stronger" } });
});
