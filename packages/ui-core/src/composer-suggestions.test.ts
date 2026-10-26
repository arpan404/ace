import { ThreadId, type CatalogEntry } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  commandArguments,
  commandSuggestions,
  composerInput,
  mentionSuggestions,
  pickSuggestion,
  referenceContext,
  suggestionToken,
  triggerAt,
} from "./index.ts";

const ace = { provider: "ace", scope: "ace" } as const;
const builtin = (action: string, name: string): CatalogEntry => ({
  id: `ace:add:${action}`,
  kind: "builtin",
  name,
  description: `${name} for this thread`,
  source: ace,
  invocation: { type: "action", action },
});
const catalog: CatalogEntry[] = [
  builtin("attach", "Attach files"),
  builtin("plan", "Plan mode"),
  builtin("automation.run:checks", "Run checks"),
  {
    id: "project:review",
    kind: "command",
    name: "review",
    description: "",
    source: { provider: "claude", scope: "project" },
    invocation: { type: "slash", name: "review" },
  },
  {
    id: "global:writing",
    kind: "skill",
    name: "writing",
    description: "Write clearly",
    source: { provider: "claude", scope: "global" },
    invocation: { type: "skill", name: "writing", path: "/skills/writing/SKILL.md" },
  },
  {
    id: "global:silent",
    kind: "skill",
    name: "silent",
    description: "",
    source: { provider: "claude", scope: "global" },
    invocation: { type: "skill", name: "silent", path: "/skills/silent/SKILL.md" },
  },
  {
    id: "global:deploy",
    kind: "command",
    name: "deploy",
    description: "Ship it to an environment",
    source: { provider: "claude", scope: "global" },
    invocation: {
      type: "prompt",
      commandId: "deploy",
      parameters: {
        target: { type: "string", required: true },
        retries: { type: "number", required: false },
        dry: { type: "boolean", required: false },
      },
    },
  },
];

test("a word starting with @ or / at the caret opens the list; text mid-word does not", () => {
  expect(triggerAt("look at @src/ma", 15)).toEqual({
    kind: "mention",
    query: "src/ma",
    start: 8,
    end: 15,
  });
  expect(triggerAt("/rev", 4)).toEqual({ kind: "command", query: "rev", start: 0, end: 4 });
  expect(triggerAt("mail me@example.com", 19)).toBeUndefined();
  expect(triggerAt("a/b/c", 5)).toBeUndefined();
});

test("typing / lists skills before commands and keeps builtins back until something is typed", () => {
  const rows = commandSuggestions(catalog, {
    query: "",
    provider: "claude",
    draft: false,
    adding: false,
  });
  expect(rows.map((row) => [row.group, row.entry?.name])).toEqual([
    ["Skills", "writing"],
    ["Commands", "review"],
    ["Commands", "deploy"],
  ]);
  expect(rows.find((row) => row.entry?.name === "review")?.detail).toBe("Run saved prompt");
});

test("the + list holds only builtins, with plan mode for Claude alone and attachments once a thread exists", () => {
  const names = (provider: "claude" | "codex", draft: boolean) =>
    commandSuggestions(catalog, { query: "", provider, draft, adding: true }).map(
      (row) => row.label,
    );
  expect(names("claude", false)).toEqual([
    "Attach files",
    "Plan mode",
    "Run checks",
    "Attachments",
  ]);
  expect(names("codex", true)).toEqual(["Attach files", "Run checks"]);
});

test("actions a client can't run are left out of its lists", () => {
  const rows = commandSuggestions(catalog, {
    query: "",
    provider: "claude",
    draft: false,
    adding: true,
    unsupported: new Set(["automation.run", "attachments"]),
  });
  expect(rows.map((row) => row.label)).toEqual(["Attach files", "Plan mode"]);
});

test("a query matches names first and falls back to descriptions", () => {
  const scope = { provider: "claude" as const, draft: false, adding: false };
  expect(
    commandSuggestions(catalog, { ...scope, query: "dep" }).map((row) => row.entry?.name),
  ).toEqual(["deploy"]);
  expect(
    commandSuggestions(catalog, { ...scope, query: "environment" }).map((row) => row.entry?.name),
  ).toEqual(["deploy"]);
});

test("@ offers recent files first, then matching tabs and the project's other threads", () => {
  const rows = mentionSuggestions({
    query: "",
    recent: ["docs/plan.md"],
    paths: ["src/main.ts", "docs/plan.md"],
    tabs: [{ tabId: "t1", url: "https://example.com/docs", title: "Docs" }],
    threads: [
      { id: "th-1", title: "Fix login", workspaceId: "w1" },
      { id: "th-2", title: "Other project", workspaceId: "w2" },
      { id: "here", title: "This one", workspaceId: "w1" },
    ],
    threadId: "here",
    workspaceId: "w1",
  });
  expect(rows.map((row) => [row.group, row.label])).toEqual([
    ["Files", "plan.md"],
    ["Files", "main.ts"],
    ["Browser tabs", "Docs"],
    ["Threads", "Fix login"],
  ]);
});

test("picking a file, thread or prompt leaves the reference the message sends", () => {
  const [file, thread] = mentionSuggestions({
    query: "",
    recent: [],
    paths: ["src/main.ts"],
    tabs: [],
    threads: [{ id: "th-1", title: "Fix login", workspaceId: "w1" }],
    threadId: undefined,
    workspaceId: "w1",
  });
  if (!file || !thread) throw new Error("missing rows");
  const fileToken = suggestionToken(file, 4);
  const threadToken = suggestionToken(thread, 17);
  expect(fileToken.label).toBe("@main.ts");
  const writing = commandSuggestions(catalog, {
    query: "writing",
    provider: "claude",
    draft: false,
    adding: false,
  })[0];
  if (!writing) throw new Error("missing skill");
  const skill = suggestionToken(writing, 0);
  const text = "Use @main.ts and Fix login";
  const shifted = { ...skill, end: 3, label: "Use" };
  expect(composerInput(text, [shifted])[0]).toMatchObject({ type: "mention", name: "writing" });
  expect(referenceContext([fileToken, threadToken])).toEqual({
    mentions: [{ path: "src/main.ts" }],
    items: [{ type: "thread_ref", threadId: "th-1", budgetBytes: 4096 }],
  });
});

test("a prompt with parameters asks for them, a builtin runs its action, and the eighth thread is too many", () => {
  const scope = { provider: "claude" as const, draft: false, adding: false };
  const deploy = commandSuggestions(catalog, { ...scope, query: "deploy" })[0];
  const attach = commandSuggestions(catalog, { ...scope, adding: true, query: "" })[0];
  if (!deploy || !attach) throw new Error("missing rows");
  expect(pickSuggestion(deploy, [])).toEqual({ kind: "arguments" });
  expect(pickSuggestion(attach, [])).toEqual({ kind: "action", action: "attach" });
  const threads = Array.from({ length: 8 }, () => ({ thread: undefined, browserTab: undefined }));
  const ref = { type: "thread_ref" as const, threadId: ThreadId.parse("x"), budgetBytes: 1 };
  const eight = threads.map(() => ({ thread: ref }));
  expect(pickSuggestion({ group: "Threads", label: "t", threadId: "t" }, threads).kind).toBe(
    "reference",
  );
  expect(pickSuggestion({ group: "Threads", label: "t", threadId: "t" }, eight).kind).toBe(
    "refused",
  );
});

test("prompt arguments must be filled where required and numbers must be numbers", () => {
  const entry = catalog.find((candidate) => candidate.name === "deploy");
  if (!entry) throw new Error("missing deploy");
  expect(commandArguments(entry, {})).toEqual({ error: "Enter target to continue." });
  expect(commandArguments(entry, { target: "prod", retries: "x" })).toEqual({
    error: "Enter a number for retries.",
  });
  expect(commandArguments(entry, { target: "prod", retries: "2", dry: "true" })).toEqual({
    values: { target: "prod", retries: 2, dry: true },
  });
});
