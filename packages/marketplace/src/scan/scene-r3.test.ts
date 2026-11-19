import { describe, expect, it } from "vitest";
import { folder } from "../testing.ts";
import { sceneCheck } from "./checks-scene.ts";
import { benignThisScenes, blockedThisScenes } from "./corpus-r3-scene.ts";

/*
 * A scene's `this` (ADR 0174 §8, fail closed): a function a timer or listener runs sees the global
 * object as `this`, so an unproven `this` is held to the allowlist as `globalThis` is, and the
 * frame members (`parent`, `top`, `opener`, `frames`, `postMessage`) are a block through any alias
 * or built name. Drawing with the scene's own parameters still passes.
 */

const blocks = (files: Record<string, string>) =>
  sceneCheck(folder(files)).filter((finding) => finding.level === "block");

describe("a scene's this and frame aliases", () => {
  it.each(blockedThisScenes.map((sample) => [sample.id, sample] as const))(
    "blocks %s",
    (_id, sample) => {
      expect(blocks(sample.files).length).toBeGreaterThan(0);
    },
  );

  it.each(benignThisScenes.map((sample) => [sample.id, sample] as const))(
    "passes %s",
    (_id, sample) => {
      const findings = sceneCheck(folder(sample.files));
      expect(findings, findings.map((f) => f.message).join("; ")).toHaveLength(0);
    },
  );

  it("names the frame a timer callback's this reaches", () => {
    const byId = new Map(blockedThisScenes.map((sample) => [sample.id, sample.files]));
    const rules = (id: string) => new Set(blocks(byId.get(id) ?? {}).map((f) => f.rule));
    expect(rules("timer-this-parent-post")).toContain("scene-parent-frame");
    expect(rules("callback-this-fetch")).toContain("scene-fetch");
    expect(rules("this-computed-parent")).toContain("scene-parent-frame");
  });
});
