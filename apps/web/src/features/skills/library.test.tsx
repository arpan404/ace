import type { SkillSeed } from "@ace/fake-daemon";
import { ThreadId, type SkillEntry } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());
await import("./skill-page.tsx");

const catalog = () => screen.getByRole("navigation", { name: "Skills catalog" });
const body = (title: string) => `# ${title}\n\nUse it well.\n`;

const seeds: SkillSeed[] = [
  {
    name: "research",
    description: "Investigate a question against primary sources.",
    body: body("Research"),
    scope: "personal",
    links: ["claude"],
    usage: {
      count: 6,
      last: { threadId: ThreadId.parse("t-release"), title: "Release 0.9.4", at: 0 },
    },
  },
  {
    name: "setup-ts-deep-modules",
    description: "Shape modules.",
    body: "Keep interfaces small.\n",
    scope: "personal",
    home: "codex",
    argumentHint: "[module]",
  },
  {
    name: "cloudflare",
    description: "Workers and Pages.",
    body: body("Cloudflare"),
    scope: "personal",
    home: "claude",
    copies: ["codex"],
  },
  {
    name: "frontend-design",
    description: "Intentional visual design.",
    body: body("Frontend design"),
    scope: "personal",
    source: {
      source: "vercel-labs/skills",
      url: "https://github.com/vercel-labs/skills.git",
      path: "skills/frontend-design/SKILL.md",
      folderHash: "0d5b74a14bdf3ebcd64f352d06376a2ef05ed2c1",
    },
  },
  {
    name: "review-changes",
    description: "Review the worktree's changes.",
    body: body("Review changes"),
    scope: "builtin",
  },
];

async function open(path: string) {
  const app = harness();
  app.daemon.skills.seed(seeds);
  await app.open(path);
  await screen.findByRole("navigation", { name: "Skills catalog" });
  return app;
}

/** What the daemon itself lists now. */
async function listed(app: ReturnType<typeof harness>): Promise<SkillEntry[]> {
  const reply = await app.client.request({
    type: "skills.request",
    operation: { op: "list" },
  });
  return reply.result.kind === "list" ? reply.result.entries : [];
}

async function idOf(app: ReturnType<typeof harness>, name: string) {
  const entry = (await listed(app)).find((each) => each.name === name);
  if (!entry) throw new Error(`No skill ${name}`);
  return entry.id;
}

/** Open a skill from the sidebar; its page replaces the last one. */
async function openSkill(title: string) {
  await userEvent.click(within(catalog()).getByRole("link", { name: new RegExp(`^${title}`) }));
  await screen.findByRole("heading", { level: 2, name: title });
}

test("skills group by where they live and only narrow skills show their agents", async () => {
  await open("/skills");
  const list = within(await screen.findByRole("navigation", { name: "Skills catalog" }));
  const personal = within(await list.findByRole("list", { name: "Personal" }));
  // Codex and Cursor read ~/.codex/skills: two agents, so the row names them.
  const narrow = within(personal.getByRole("link", { name: /^Setup TS deep modules/ }));
  expect(narrow.getAllByRole("img").map((mark) => mark.getAttribute("aria-label"))).toEqual([
    "Codex",
    "Cursor",
  ]);
  // Every agent reaches Research: the row stays quiet.
  expect(within(personal.getByRole("link", { name: "Research" })).queryAllByRole("img")).toEqual(
    [],
  );
  const builtin = within(list.getByRole("list", { name: "Built into ace" }));
  expect(builtin.getByRole("link", { name: "Review changes" })).toBeTruthy();
});

test("a skill's page shows who loads it, where it lives, its arguments and its use", async () => {
  await open("/skills");
  await openSkill("Setup TS deep modules");
  const details = within(screen.getByRole("region", { name: "Details" }));
  expect(details.getByText("Codex and Cursor")).toBeTruthy();
  expect(details.getByText("~/.codex/skills/setup-ts-deep-modules")).toBeTruthy();
  expect(details.getByText("Agents load it by themselves when it fits")).toBeTruthy();
  expect(details.getByText("[module]")).toBeTruthy();
  expect(details.getByText("Not used yet")).toBeTruthy();
  expect(await screen.findByText("Keep interfaces small.")).toBeTruthy();

  await openSkill("Research");
  const used = within(screen.getByRole("region", { name: "Details" }));
  expect(await used.findByRole("link", { name: "Release 0.9.4" })).toBeTruthy();
  expect(used.getByText(/^6 times · last in/)).toBeTruthy();
  // The instructions don't repeat the title the page already shows.
  expect(await screen.findByText("Use it well.")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Research", level: 1 })).toBeNull();
});

test("an agent keeping its own copy is named and can't be unticked", async () => {
  await open("/skills");
  await openSkill("Cloudflare");
  expect(screen.getByText(/each keeps its own copy/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Change" }));
  const codex = await screen.findByRole("menuitemcheckbox", { name: "Codex" });
  expect(codex.getAttribute("aria-checked")).toBe("true");
  expect(codex.getAttribute("aria-disabled")).toBe("true");
});

test("ticking agents is one change, sent when the menu closes", async () => {
  const app = await open("/skills");
  await openSkill("Setup TS deep modules");
  await userEvent.click(screen.getByRole("button", { name: "Change" }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Claude Code" }));
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Pi" }));
  // Nothing is sent while the menu is open.
  expect((await listed(app)).find((s) => s.name === "setup-ts-deep-modules")?.agents).toHaveLength(
    2,
  );
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByText("Claude Code, Codex, Cursor and Pi")).toBeTruthy();
  const agents = (await listed(app))
    .find((s) => s.name === "setup-ts-deep-modules")
    ?.agents.map((agent) => agent.provider);
  expect(agents).toEqual(["claude", "codex", "cursor", "pi"]);
});

test("editing saves the description, instructions and Runs together", async () => {
  const app = await open("/skills");
  await openSkill("Setup TS deep modules");
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("form", { name: "Edit skill" }));
  // The name isn't editable.
  expect(form.queryByRole("textbox", { name: "Name" })).toBeNull();
  await userEvent.clear(form.getByRole("textbox", { name: "Description" }));
  await userEvent.type(form.getByRole("textbox", { name: "Description" }), "Deep modules.");
  await userEvent.clear(form.getByRole("textbox", { name: "Instructions" }));
  await userEvent.type(form.getByRole("textbox", { name: "Instructions" }), "Hide the details.");
  await userEvent.click(form.getByRole("button", { name: "Only when picked" }));
  await userEvent.click(form.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Hide the details.")).toBeTruthy();
  // Codex ignores the manual flag, so the page doesn't promise it for every agent.
  expect(
    screen.getByText("Cursor never loads it by itself. Codex may still load it."),
  ).toBeTruthy();
  const saved = (await listed(app)).find((s) => s.name === "setup-ts-deep-modules");
  expect(saved).toMatchObject({ description: "Deep modules.", manual: true });
});

test("a save after the skill changed elsewhere says so and Reload brings the new text", async () => {
  const app = await open("/skills");
  await openSkill("Setup TS deep modules");
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("form", { name: "Edit skill" }));
  // Someone else edits the file meanwhile.
  const entry = (await listed(app)).find((s) => s.name === "setup-ts-deep-modules");
  if (!entry) throw new Error("missing");
  await app.client.request({
    type: "skills.request",
    operation: {
      op: "edit",
      id: entry.id,
      expectedHash: entry.hash,
      description: "Shape modules.",
      body: "Changed elsewhere.\n",
      manual: false,
    },
  });
  await userEvent.type(form.getByRole("textbox", { name: "Instructions" }), " Mine.");
  await userEvent.click(form.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("This skill changed since you opened it.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() =>
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Instructions" }).value).toBe(
      "Changed elsewhere.\n",
    ),
  );
});

test("built-in skills can be read and used, not changed", async () => {
  await open("/skills");
  await openSkill("Review changes");
  expect(screen.getByRole("link", { name: "Use in a thread" })).toBeTruthy();
  expect(screen.getByText("Every agent")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Runs" })).toBeNull();
  expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
});

test("deleting asks first with focus on Cancel, then removes the skill", async () => {
  const app = await open("/skills");
  await openSkill("Research");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete skill…" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Research?" });
  expect(within(dialog).getByText(/~\/\.agents\/skills\/research/)).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete skill" }));

  await waitFor(async () =>
    expect((await listed(app)).some((s) => s.name === "research")).toBe(false),
  );
  await waitFor(() =>
    expect(within(catalog()).queryByRole("link", { name: "Research" })).toBeNull(),
  );
});

test("a new skill needs a free slug name and opens once created", async () => {
  const app = await open("/skills");
  await screen.findByRole("navigation", { name: "Skills catalog" });
  await userEvent.click(screen.getByRole("button", { name: "Add a skill" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "New skill" }));
  await screen.findByRole("heading", { level: 2, name: "New skill" });

  const name = screen.getByRole("textbox", { name: "Name" });
  await userEvent.type(name, "Release Notes");
  expect(screen.getByText("Use lowercase letters, digits and dashes.")).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "research");
  expect(screen.getByText("You already have a skill called research.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create skill" })).toHaveProperty("disabled", true);
  await userEvent.clear(name);
  await userEvent.type(name, "release-notes");
  expect(screen.getByText("~/.agents/skills/release-notes/SKILL.md")).toBeTruthy();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Description" }),
    "Write release notes from merged pull requests.",
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Instructions" }), "Group by area.");
  await userEvent.click(screen.getByRole("button", { name: "Only when picked" }));
  await userEvent.click(screen.getByRole("button", { name: "Create skill" }));

  expect(await screen.findByRole("heading", { level: 2, name: "Release notes" })).toBeTruthy();
  const created = (await listed(app)).find((s) => s.name === "release-notes");
  expect(created).toMatchObject({ scope: "personal", manual: true });
});

test("a skill from a source checks for an update and applies it after review", async () => {
  const app = await open("/skills");
  await openSkill("Frontend design");
  const details = within(screen.getByRole("region", { name: "Details" }));
  expect(details.getByText(/^vercel-labs\/skills/)).toBeTruthy();
  await userEvent.click(details.getByRole("button", { name: "Check for update" }));
  expect(await details.findByText(/Update available/)).toBeTruthy();
  await userEvent.click(details.getByRole("button", { name: "Review update" }));

  const dialog = await screen.findByRole("dialog", { name: "Update Frontend design" });
  const files = within(within(dialog).getByRole("region", { name: "Files" }));
  expect(files.getByText("scripts/check.sh")).toBeTruthy();
  expect(files.getByText("Agents may run it")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Update" }));

  expect(await screen.findByText("A clearer checklist.")).toBeTruthy();
  const id = await idOf(app, "frontend-design");
  const read = await app.client.request({
    type: "skills.request",
    operation: { op: "read", id },
  });
  expect(read.result.kind === "skill" && read.result.text).toContain("What's new");
});
