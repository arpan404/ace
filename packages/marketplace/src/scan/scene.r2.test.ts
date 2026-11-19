import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { folder } from "../testing.ts";
import { sceneCheck } from "./checks-scene.ts";
import { benignScenes, blockedScenes } from "./corpus-r2-scene.ts";

/*
 * The Suit scene allowlist (ADR 0174 §8): a scene is parsed and held to the capabilities a
 * drawing needs, so a capability reached by a built name, reflection or an alias is a block, and
 * the Suit's CSS and ornaments load nothing from outside it. Every scene ace ships must pass.
 */

const blocks = (files: Record<string, string>) =>
  sceneCheck(folder(files)).filter((finding) => finding.level === "block");

const rulesOf = (files: Record<string, string>) => new Set(blocks(files).map((f) => f.rule));

describe("the scene allowlist", () => {
  it.each(blockedScenes.map((sample) => [sample.id, sample] as const))(
    "blocks %s",
    (_id, sample) => {
      expect(blocks(sample.files).length).toBeGreaterThan(0);
    },
  );

  it.each(benignScenes.map((sample) => [sample.id, sample] as const))(
    "passes %s",
    (_id, sample) => {
      const findings = sceneCheck(folder(sample.files));
      expect(findings, findings.map((f) => f.message).join("; ")).toHaveLength(0);
    },
  );

  it("names the capability a built property name reaches", () => {
    const byId = new Map(blockedScenes.map((sample) => [sample.id, sample.files]));
    const rules = (id: string) => rulesOf(byId.get(id) ?? {});
    expect(rules("computed-member-fetch")).toContain("scene-fetch");
    expect(rules("constructor-escape")).toContain("scene-reflection");
    expect(rules("function-from-string")).toContain("scene-function-constructor");
    expect(rules("dynamic-import-remote")).toContain("scene-dynamic-import");
    expect(rules("dynamic-import-remote")).toContain("scene-remote-url");
    expect(rules("string-timer")).toContain("scene-string-timer");
    expect(rules("webassembly")).toContain("scene-wasm");
    expect(rules("built-constructor-name")).toContain("scene-built-name");
    expect(rules("unreadable")).toContain("scene-unreadable");
    expect(rules("css-remote-url")).toContain("suit-css-remote-url");
    expect(rules("css-escaped-remote-url")).toContain("suit-css-remote-url");
  });

  it("reads a local binding by its scope, not its name", () => {
    // A parameter named `fetch` is the scene's own value; the global of that name stays blocked.
    expect(
      blocks({
        "scene.js":
          "ace.scene({ frame(time, fetch) { fetch.canvas.width; }, init(fetch) { fetch.width(0, 0, 1, 1); } });",
      }),
    ).toHaveLength(0);
    expect(
      rulesOf({
        "scene.js":
          "function draw(fetch) { return fetch; }\nace.scene({ frame() { fetch('/'); } });",
      }),
    ).toContain("scene-fetch");
  });

  it("refuses a name built before the function that uses it is declared", () => {
    const rules = rulesOf({
      "scene.js":
        "function grab(o) { return o[k]; }\nconst k = ['con', 'structor'].join('');\nace.scene({ frame(t, v) { grab(v.canvas)('x'); } });",
    });
    expect(rules).toContain("scene-built-name");
  });

  it("passes every scene ace ships", () => {
    const root = new URL("../../../plugins/builtin-suits/", import.meta.url);
    const suits = readdirSync(root);
    expect(suits.length).toBeGreaterThan(0);
    for (const suit of suits) {
      const files: Record<string, string> = {};
      for (const name of readdirSync(new URL(`${suit}/`, root)))
        if (/\.(?:js|css)$/.test(name))
          files[name] = readFileSync(new URL(`${suit}/${name}`, root), "utf8");
      const found = blocks(files);
      expect(found, `${suit}: ${found.map((f) => f.message).join("; ")}`).toHaveLength(0);
    }
  });
});
