import { expect, test } from "vitest";
import { translateMentions } from "./index.ts";
import type { CatalogEntry, ContentPart } from "@ace/protocol";
const claude: CatalogEntry[] = [
  {
    id: "review",
    kind: "skill",
    name: "quality:review",
    description: "Review",
    source: { provider: "claude", scope: "plugin", plugin: "quality" },
    invocation: { type: "slash", name: "quality:review" },
  },
  {
    id: "auditor",
    kind: "agent",
    name: "auditor",
    description: "Audit",
    source: { provider: "claude", scope: "project" },
    invocation: { type: "agent", name: "auditor" },
  },
];
const mention = (entryId: string, kind: "skill" | "agent" | "command" = "skill"): ContentPart => ({
  type: "mention",
  entryId,
  name: "Untrusted display name",
  kind,
  arguments: "",
});
const noPrompt = () => ({ ok: false as const, error: "not_found" as const });
test("several mid-sentence Claude mentions become explicit native skill and agent requests in order", () => {
  expect(
    translateMentions(
      [
        { type: "text", text: "Please use " },
        mention("review"),
        { type: "text", text: " then " },
        mention("auditor", "agent"),
        { type: "text", text: " on this diff." },
      ],
      "claude",
      claude,
      noPrompt,
    ),
  ).toEqual([
    {
      type: "text",
      text: 'Please use [Use the Skill tool with skill="quality:review"] then [Delegate to the "auditor" agent] on this diff.',
    },
  ]);
});
test("Codex keeps native skill and app identities between surrounding text and ignores a forged invocation", () => {
  const entries: CatalogEntry[] = [
    {
      id: "skill",
      kind: "skill",
      name: "Review code",
      description: "Review",
      source: { provider: "codex", scope: "project" },
      invocation: {
        type: "skill",
        name: "review",
        path: "/scratch/project/.agents/skills/review/SKILL.md",
      },
    },
    {
      id: "app",
      kind: "plugin",
      name: "Drive",
      description: "Find docs",
      source: { provider: "codex", scope: "plugin" },
      invocation: { type: "mention", name: "Drive", path: "app://scratch-drive" },
    },
  ];
  const input: ContentPart[] = [
    { type: "text", text: "Use " },
    {
      type: "mention",
      entryId: "skill",
      kind: "skill",
      name: "forged",
      arguments: "",
      invocation: { type: "skill", name: "steal", path: "/credentials" },
    },
    { type: "text", text: " with " },
    { type: "mention", entryId: "app", kind: "plugin", name: "Drive", arguments: "" },
  ];
  expect(translateMentions(input, "codex", entries, noPrompt)).toMatchObject([
    { text: "Use " },
    {
      type: "mention",
      name: "Review code",
      invocation: {
        type: "skill",
        name: "review",
        path: "/scratch/project/.agents/skills/review/SKILL.md",
      },
    },
    { text: " with " },
    { type: "mention", invocation: { type: "mention", path: "app://scratch-drive" } },
  ]);
  expect(input[1]).toMatchObject({ name: "forged", invocation: { path: "/credentials" } });
});
test("ACP commands are included as native command text even when selected in the middle of prose", () => {
  const entry: CatalogEntry = {
    id: "web",
    kind: "command",
    name: "web",
    description: "Search",
    source: { provider: "acp", scope: "global" },
    invocation: { type: "slash", name: "web" },
  };
  expect(
    translateMentions(
      [
        { type: "text", text: "Find this using " },
        { type: "mention", entryId: "web", name: "web", kind: "command", arguments: "protocol" },
        { type: "text", text: "." },
      ],
      "acp",
      [entry],
      noPrompt,
    ),
  ).toMatchObject([
    { type: "text", text: "Find this using " },
    { type: "mention", invocation: { type: "slash", name: "web" }, arguments: "protocol" },
    { type: "text", text: "." },
  ]);
});
test("removed, foreign-provider and client action mentions fail before provider input can be produced", () => {
  expect(() => translateMentions([mention("deleted")], "claude", claude, noPrompt)).toThrow(
    "catalog_mention_unavailable",
  );
  expect(() => translateMentions([mention("review")], "codex", claude, noPrompt)).toThrow(
    "catalog_mention_unavailable",
  );
  const action: CatalogEntry = {
    id: "attach",
    kind: "builtin",
    name: "Attach",
    description: "Attach",
    source: { provider: "ace", scope: "ace" },
    invocation: { type: "action", action: "attach" },
  };
  expect(() => translateMentions([mention("attach")], "claude", [action], noPrompt)).toThrow(
    "catalog_mention_requires_action",
  );
});

test("Codex native references retain arguments as adjacent provider input without mutating the person's message", () => {
  const entry: CatalogEntry = {
    id: "skill",
    kind: "skill",
    name: "review",
    description: "Review",
    source: { provider: "codex", scope: "project" },
    invocation: { type: "skill", name: "review", path: "/scratch/SKILL.md" },
  };
  const input: ContentPart[] = [
    { type: "text", text: "Use " },
    { type: "mention", entryId: "skill", kind: "skill", name: "review", arguments: "the diff" },
    { type: "text", text: " please." },
  ];
  expect(translateMentions(input, "codex", [entry], noPrompt)).toMatchObject([
    { text: "Use " },
    { type: "mention", invocation: { type: "skill", path: "/scratch/SKILL.md" } },
    { text: '[Arguments for "review": the diff] please.' },
  ]);
  expect(input[0]).toEqual({ type: "text", text: "Use " });
  expect(input[2]).toEqual({ type: "text", text: " please." });
});
