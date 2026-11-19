import { describe, expect, it } from "vitest";
import { checkFiles } from "../checks/index.ts";
import { folder } from "../testing.ts";
import { disposition, scanEntry, type ScanContext } from "./index.ts";

/*
 * The policy layer (ADR 0174 §8): a version with runnable content is held for a maintainer, only
 * pure data lists on scan pass alone, and an undecodable file that isn't recognised data is held
 * (finding 1). The scanner is a filter in front of runtime containment, not the boundary.
 */

const context: ScanContext = { entries: [], verified: [] };
const suitJson = (id: string, scene = false) =>
  JSON.stringify({
    format: 1,
    id,
    name: "Harbour dusk",
    description: "Slate panels.",
    version: "1",
    base: "ace",
    light: {},
    dark: {},
    ...(scene ? { scenes: { app: "scene.js" } } : {}),
  });

const ordinary = { newPublisher: false, firstVersion: false, official: false, approved: false };
const skillMd = (name: string, body = "This skill explains a small chore in prose.") =>
  `---\nname: ${name}\ndescription: Does a small chore.\n---\n# ${name}\n\n${body}\n`;

function scan(
  type: Parameters<typeof checkFiles>[0],
  name: string,
  files: Record<string, string | Uint8Array>,
) {
  const archive = folder(files);
  const checked = checkFiles(type, name, archive);
  return scanEntry({
    type,
    name,
    files: archive,
    listing: checked.listing,
    inspection: checked.inspection,
    context,
  });
}

// A minimal valid PNG header: recognised safe data.
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);

describe("runnable content is held, pure data lists", () => {
  it("holds a skill that carries a script", () => {
    const report = scan("spade-skill", "has-script", {
      "SKILL.md": skillMd("has-script"),
      "scripts/run.sh*": "#!/bin/sh\necho tidy\n",
    });
    expect(report.verdict).toBe("pass");
    expect(report.runnable).toBe(true);
    expect(disposition(report, ordinary)).toBe("hold");
  });

  it("lists a skill that is only prose and a picture", () => {
    const report = scan("spade-skill", "pure-data", {
      "SKILL.md": skillMd("pure-data"),
      "assets/diagram.png": png,
    });
    expect(report.verdict).toBe("pass");
    expect(report.runnable).toBe(false);
    expect(disposition(report, ordinary)).toBe("list");
  });

  it("holds a Suit with a scene, lists one without", () => {
    const withScene = scan("suit", "lively", {
      "suit.json": suitJson("lively", true),
      "scene.js": "export function scene(ctx) { ctx.fillRect(0, 0, 4, 4); }",
      "market.json": JSON.stringify({ line: "Lively." }),
    });
    expect(withScene.runnable).toBe(true);
    expect(disposition(withScene, ordinary)).toBe("hold");

    const still = scan("suit", "calm", {
      "suit.json": suitJson("calm"),
      "market.json": JSON.stringify({ line: "Calm." }),
    });
    expect(still.verdict).toBe("pass");
    expect(still.runnable).toBe(false);
    expect(disposition(still, ordinary)).toBe("list");
  });

  it("holds even an official publisher's runnable version", () => {
    const report = scan("spade-skill", "official-script", {
      "SKILL.md": skillMd("official-script"),
      "scripts/run.sh*": "#!/bin/sh\necho hi\n",
    });
    expect(
      disposition(report, {
        newPublisher: false,
        firstVersion: false,
        official: true,
        approved: false,
      }),
    ).toBe("hold");
    // A maintainer's approval still lets it list.
    expect(
      disposition(report, {
        newPublisher: false,
        firstVersion: false,
        official: false,
        approved: true,
      }),
    ).toBe("list");
  });
});

describe("an undecodable file that isn't recognised data is held (finding 1)", () => {
  it("holds a skill whose instruction runs an unreadable binary", () => {
    const report = scan("spade-skill", "binary-payload", {
      "SKILL.md": skillMd("binary-payload", "Run: bash payload.dat"),
      "payload.dat": Uint8Array.of(0x23, 0xff, 0x00, 0x0a, 0x01, 0x02),
    });
    // The entry is runnable, and the binary itself is held, so it never lists on a pass.
    expect(report.runnable).toBe(true);
    expect(report.findings.some((f) => f.rule === "unreadable-binary")).toBe(true);
    expect(disposition(report, ordinary)).not.toBe("list");
  });

  it("does not hold a recognised image", () => {
    const report = scan("spade-skill", "just-image", {
      "SKILL.md": skillMd("just-image"),
      "assets/pic.png": png,
    });
    expect(report.findings.some((f) => f.rule === "unreadable-binary")).toBe(false);
  });
});
