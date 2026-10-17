import { expect, test } from "vitest";
import { translateMentions } from "./index.ts";
import type { CatalogEntry, ContentPart, ProviderKind } from "@ace/protocol";

const noPrompt = () => ({ ok: false as const, error: "not_found" as const });
const entry = (
  id: string,
  provider: ProviderKind | "ace",
  invocation: CatalogEntry["invocation"],
): CatalogEntry => ({
  id,
  kind: "skill",
  name: id,
  description: "A skill",
  source: { provider, scope: provider === "ace" ? "ace" : "global" },
  invocation,
});
const chip = (entryId: string, args = ""): ContentPart => ({
  type: "mention",
  entryId,
  name: "Display only",
  kind: "skill",
  arguments: args,
});
const files: Record<string, { path: string; body: string }> = {
  review: { path: "/home/me/.cursor/skills/review/SKILL.md", body: "Read checklist.md.\n" },
  release: {
    path: "/home/me/.cursor/skills/release/SKILL.md",
    body: "Ship version $ARGUMENTS today.",
  },
  visualize: { path: "/opt/ace/builtin-skills/skills/visualize/SKILL.md", body: "Draw it." },
};
const read = (selected: CatalogEntry) => {
  const file = files[selected.id];
  return file ? { name: selected.name, ...file } : undefined;
};

test("a Cursor skill reaches the agent as its SKILL.md body with its directory, ahead of the person's words", () => {
  expect(
    translateMentions(
      [{ type: "text", text: "Please " }, chip("review"), { type: "text", text: " this diff." }],
      "cursor",
      [entry("review", "cursor", { type: "skill", name: "review", path: files.review!.path })],
      noPrompt,
      read,
    ),
  ).toEqual([
    {
      type: "text",
      text: [
        '<skill name="review" path="/home/me/.cursor/skills/review/SKILL.md">',
        'The person selected the "review" skill for this message. Follow its instructions below. Resolve relative paths in it against "/home/me/.cursor/skills/review".',
        "",
        "Read checklist.md.",
        "</skill>",
        "",
        "Please [skill: review] this diff.",
      ].join("\n"),
    },
  ]);
});

test("Cursor skill arguments fill the skill's $ARGUMENTS placeholder instead of a bare slash command", () => {
  const [part] = translateMentions(
    [chip("release", "2.4.0")],
    "cursor",
    [entry("release", "cursor", { type: "skill", name: "release", path: files.release!.path })],
    noPrompt,
    read,
  );
  expect(part).toMatchObject({ type: "text" });
  const text = part?.type === "text" ? part.text : "";
  expect(text).toContain("Ship version 2.4.0 today.");
  expect(text.endsWith("[skill: release]")).toBe(true);
  expect(text).not.toMatch(/^\/release/m);
});

test("arguments for a skill without a placeholder are appended to its instructions", () => {
  const [part] = translateMentions(
    [chip("review", "focus on auth")],
    "cursor",
    [entry("review", "cursor", { type: "skill", name: "review", path: files.review!.path })],
    noPrompt,
    read,
  );
  expect(part?.type === "text" && part.text).toContain(
    "Read checklist.md.\n\nARGUMENTS: focus on auth\n</skill>",
  );
});

test("ace's shipped skills are injected for every provider, even those with native skill input", () => {
  const visualize = entry("visualize", "ace", {
    type: "skill",
    name: "visualize",
    path: files.visualize!.path,
  });
  for (const provider of [
    "claude",
    "codex",
    "opencode",
    "pi",
    "acp",
    "antigravity",
    "cursor",
  ] as const) {
    const parts = translateMentions([chip("visualize")], provider, [visualize], noPrompt, read);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type === "text" && parts[0].text).toContain("Draw it.\n</skill>");
  }
});

test("a Claude skill is dispatched natively by name rather than described in prose", () => {
  expect(
    translateMentions(
      [chip("review", "focus on auth")],
      "claude",
      [entry("review", "claude", { type: "slash", name: "review" })],
      noPrompt,
      read,
    ),
  ).toMatchObject([
    { type: "mention", arguments: "focus on auth", invocation: { type: "slash", name: "review" } },
  ]);
});

test("Codex keeps the typed skill item and adds its documented $name marker", () => {
  expect(
    translateMentions(
      [{ type: "text", text: "Run " }, chip("lint")],
      "codex",
      [entry("lint", "codex", { type: "skill", name: "lint", path: "/c/skills/lint/SKILL.md" })],
      noPrompt,
      read,
    ),
  ).toMatchObject([
    { type: "text", text: "Run $lint" },
    { type: "mention", invocation: { type: "skill", path: "/c/skills/lint/SKILL.md" } },
  ]);
});

test("a Cursor skill whose SKILL.md cannot be read fails before any provider input exists", () => {
  expect(() =>
    translateMentions(
      [chip("missing")],
      "cursor",
      [entry("missing", "cursor", { type: "skill", name: "missing", path: "/gone/SKILL.md" })],
      noPrompt,
      read,
    ),
  ).toThrow("catalog_skill_unavailable");
});

test("several large skills in one message are refused rather than truncated", () => {
  const big = { path: "/s/big/SKILL.md", body: "x".repeat(60 * 1024) };
  const many = Array.from({ length: 5 }, (_, index) =>
    entry(`big${index}`, "cursor", { type: "skill", name: `big${index}`, path: big.path }),
  );
  expect(() =>
    translateMentions(
      many.map((item) => chip(item.id)),
      "cursor",
      many,
      noPrompt,
      (selected) => ({ name: selected.name, ...big }),
    ),
  ).toThrow("catalog_skill_too_large");
});
