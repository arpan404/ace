import { facts, workCardScenario, type Scenario } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  agentTree,
  currentCheckout,
  gitAction,
  machineRow,
  nextGitStep,
  openWorkCard,
  openWorkPanel,
  workButton,
} from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());

type Details = Partial<NonNullable<Scenario["thread"]["details"]>>;

/** A work-card fixture thread with its card opened from the header's details icon. */
async function open(state: Parameters<typeof workCardScenario>[0], details: Details = {}) {
  const app = harness();
  const fixture = workCardScenario(state);
  fixture.thread.details = { ...fixture.thread.details, ...details };
  app.play(fixture).runUntilBlocked();
  const view = await app.open(`/t/${fixture.thread.id}`);
  return { app, view, threadId: fixture.thread.id, card: await openWorkCard() };
}

function ahead(app: ReturnType<typeof harness>, threadId: string) {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
  return view && "thread" in view ? view.thread.details?.ahead : undefined;
}

test("the details card holds the workspace and branch only; what runs lives in Summary", async () => {
  const { card } = await open("changes");
  const environment = within(card).getByRole("region", { name: "Workspace" });
  expect(within(environment).getByRole("button", { name: machineRow })).toBeTruthy();
  expect(within(environment).getByRole("button", { name: /^Open in / })).toBeTruthy();
  expect(within(environment).getByRole("button", { name: "Add project script" })).toBeTruthy();
  expect(await currentCheckout()).toBe("Local");
  const git = within(card).getByRole("region", { name: "Branch" });
  expect(
    await within(git).findByRole("button", { name: "Branch fix/restart-retry, switch branch" }),
  ).toBeTruthy();
  // The background command and the subagents have one home: the Summary tab.
  expect(within(card).queryByRole("region", { name: "Running" })).toBeNull();
  expect(within(card).queryByRole("button", { name: /^Show .* output$/ })).toBeNull();
  expect(within(card).queryByRole("button", { name: /subagents? working/ })).toBeNull();
  await userEvent.keyboard("{Escape}");
  const summary = await openWorkPanel();
  const tree = await agentTree(summary);
  expect(within(tree).getByRole("treeitem", { name: "$ bun run dev: running" })).toBeTruthy();
});

test("the git menu marks Commit & push next while the checkout has uncommitted changes", async () => {
  await open("changes");
  expect(await nextGitStep()).toBe("Commit & push…");
  await gitAction("Commit & push…");
  const dialog = await screen.findByRole("dialog", { name: "Commit to fix/restart-retry" });
  expect(
    within(dialog)
      .getByRole("checkbox", { name: "Push after committing" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("the Changes header offers the next git step and opens the same commit form", async () => {
  await open("changes");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  await within(panel).findByRole("tab", { name: /^Changes/, selected: true });
  const toolbar = await within(panel).findByRole("toolbar", { name: "Changes" });
  await userEvent.click(await within(toolbar).findByRole("button", { name: "Commit & push" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit to fix/restart-retry" });
  expect(
    within(dialog)
      .getByRole("checkbox", { name: "Push after committing" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  // Its chevron holds every other step, as the card's does.
  await userEvent.keyboard("{Escape}");
  await userEvent.click(within(toolbar).getByRole("button", { name: "More git actions" }));
  expect(await screen.findByRole("menuitem", { name: "Commit…" })).toBeTruthy();
});

test("with only unpushed commits the sync row counts them and Push is next, and once pushed Create PR is", async () => {
  const { app, threadId, card } = await open("worktree", { ahead: 2, upstream: "origin/fix" });
  const git = within(card).getByRole("region", { name: "Branch" });
  expect(await within(git).findByRole("button", { name: "2 to push, git actions" })).toBeTruthy();
  expect(await nextGitStep()).toBe("Push");
  await gitAction("Push");
  const confirm = await screen.findByRole("dialog", { name: "Push fix/restart-retry?" });
  expect(ahead(app, threadId)).toBe(2);
  await userEvent.click(within(confirm).getByRole("button", { name: "Push" }));
  await waitFor(() => expect(ahead(app, threadId)).toBe(0));
  const after = within(await openWorkCard()).getByRole("region", { name: "Branch" });
  expect(await within(after).findByText("Up to date with origin")).toBeTruthy();
  expect(within(after).queryByText("2 to push")).toBeNull();
  expect(await nextGitStep()).toBe("Create PR…");
});

test.each([
  { details: { upstream: null }, words: "Not pushed yet" },
  { details: { upstream: "origin/fix", behind: 3 }, words: "3 behind origin" },
  {
    details: { upstream: "origin/fix", ahead: 1, behind: 2 },
    words: "1 to push · 2 behind origin",
  },
  { details: { upstream: "origin/fix" }, words: "Up to date with origin" },
])("the sync row reads $words in normal ink", async ({ details, words }) => {
  const { card } = await open("worktree", details);
  const row = within(card).getByRole("button", { name: `${words}, git actions` });
  expect(row.textContent).toBe(words);
  expect(row.hasAttribute("disabled")).toBe(false);
});

test("a clean worktree says so after the machine's name, and its git menu opens the pull request form", async () => {
  const { card } = await open("worktree");
  expect(await currentCheckout()).toBe("Worktree");
  expect(within(card).getByRole("button", { name: machineRow }).textContent).toMatch(/· worktree$/);
  await gitAction("Create PR…");
  expect(await screen.findByRole("dialog", { name: "Open a pull request" })).toBeTruthy();
});

test("commit without pushing stays available behind More git actions", async () => {
  await open("changes");
  await gitAction("Commit…");
  const dialog = await screen.findByRole("dialog", { name: "Commit to fix/restart-retry" });
  expect(
    within(dialog)
      .getByRole("checkbox", { name: "Push after committing" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("the sync row's uncommitted value counts the files and opens Changes on that same scope", async () => {
  const { card } = await open("changes");
  const branch = within(card).getByRole("region", { name: "Branch" });
  const files = await within(branch).findByRole("button", {
    name: "Uncommitted changes, 2 files: 34 added, 1 removed",
  });
  expect(files.textContent).toBe("2 files");
  // Folded into the sync row: no row of its own.
  expect(within(branch).queryByText("Uncommitted")).toBeNull();
  await userEvent.click(files);
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(panel).findByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
  expect(await within(panel).findByRole("button", { name: "Scope: Uncommitted" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
});

test("the PR line names the pull request once, with its state and no stack noise", async () => {
  const { card } = await open("changes");
  expect(
    await within(card).findByRole("button", {
      name: /^Open pull request #188: Retry budget, open/,
    }),
  ).toBeTruthy();
  expect(within(card).getAllByText(/#188/)).toHaveLength(1);
  expect(
    within(card).queryByText(/Stack membership unavailable|missing or inaccessible/),
  ).toBeNull();
});

test("a merged PR reads merged without Merge, and the git action starts a new PR", async () => {
  const { card } = await open("merged");
  expect(
    await within(card).findByRole("button", { name: /^Open pull request #188.*merged/ }),
  ).toBeTruthy();
  expect(within(card).queryByRole("button", { name: /^Merge pull request/ })).toBeNull();
  expect(await nextGitStep()).toBe("Create PR…");
});

test("a clean checkout's uncommitted value reads No changes and still opens Changes", async () => {
  const { card } = await open("worktree");
  const none = await within(card).findByRole("button", { name: "Uncommitted changes, none" });
  expect(none.textContent).toBe("No changes");
  await userEvent.click(none);
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(panel).findByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
});

test("Merge on a PR the forge can't read says so without the server's raw error", async () => {
  const { app, card } = await open("changes");
  app.daemon.refuseCommands("private_server_detail_571", "forge.pr.status");
  await userEvent.click(
    await within(card).findByRole("button", { name: "Merge pull request #188" }),
  );
  expect(await screen.findByRole("alertdialog", { name: "Couldn't merge" })).toBeTruthy();
  expect(screen.queryByText(/private_server_detail_571/)).toBeNull();
  expect(screen.queryByRole("dialog", { name: /^Merge PR/ })).toBeNull();
});

test("a remote thread's card names its machine, and the link field opens only when asked", async () => {
  const { card } = await open("remote");
  expect(within(card).getByRole("button", { name: /^Build server, / })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Pull request" })).toBeNull();
  await gitAction("Link a pull request…");
  const dialog = await screen.findByRole("dialog", { name: "Link an existing pull request" });
  expect(within(dialog).getByRole("textbox", { name: "Pull request" })).toBeTruthy();
});

test("opening and closing the card keeps the composer draft", async () => {
  await open("worktree");
  const input = screen.getByRole("combobox", { name: "Message" });
  await userEvent.type(input, "Continue this draft");
  expect(input.textContent).toBe("Continue this draft");
  await openWorkCard();
  await userEvent.click(await workButton());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
  expect(input.textContent).toBe("Continue this draft");
});

/** A subagent the root started: running until its turn ends, done or failed after. */
function spawn(id: string, name: string, end?: "done" | "failed"): Fact[] {
  const key = `spawn-${id}`;
  const started: Fact[] = [
    facts.tool("root", key, {
      kind: "agent.spawn",
      title: name,
      detail: { kind: "agent.spawn", description: name, childAgent: id },
    }),
    facts.subagent("codex", id, name, key),
    facts.turn(id, "spawn"),
    facts.toolDone("root", key),
  ];
  if (end === "done") return [...started, facts.endTurn(id)];
  if (end === "failed")
    return [
      ...started,
      facts.endTurn(id, "failed", {
        code: "fixture_failure",
        message: "The test command failed.",
        kind: "provider",
      }),
    ];
  return started;
}

async function openAgents(id: string, title: string, agentFacts: Fact[]) {
  const app = harness();
  app.daemon.createThread({ id, workspaceId: "relay", provider: "codex", title });
  app.daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root"), ...agentFacts]);
  await app.open(`/t/${id}`);
  await screen.findByRole("heading", { level: 1, name: title });
  return { app, card: await openWorkCard() };
}

test("the main agent's card lists the subagents it started, and a row opens that subagent", async () => {
  const app = harness();
  app.play(workCardScenario("changes")).runUntilBlocked();
  app.daemon.createThread({
    id: "agents-empty",
    workspaceId: "relay",
    provider: "codex",
    title: "Empty thread",
  });
  app.daemon.apply("agents-empty", [facts.rootAgent("codex"), facts.turn("root")]);
  const view = await app.open("/t/work-card-changes");
  let card = await openWorkCard();
  let agents = within(card).getByRole("region", { name: "Agents" });
  expect(within(agents).getByRole("button", { name: /^Open Write retry tests,/ })).toBeTruthy();
  expect(within(agents).queryByRole("button", { name: /^Open Read restart history,/ })).toBeNull();
  await userEvent.click(within(agents).getByRole("button", { name: "1 working · 1 finished" }));
  expect(within(agents).getByRole("button", { name: /^Open Read restart history,/ })).toBeTruthy();
  await userEvent.click(within(agents).getByRole("button", { name: /^Open Write retry tests,/ }));
  await screen.findByRole("heading", { level: 1, name: "Write retry tests" });
  view.unmount();
  await app.open("/t/agents-empty");
  await screen.findByRole("heading", { level: 1, name: "Empty thread" });
  card = await openWorkCard();
  expect(within(card).queryByRole("region", { name: "Agents" })).toBeNull();
});

test("running subagents show while settled ones fold under a line counting what happened to each", async () => {
  const { card } = await openAgents("agents-mix", "Agents mix", [
    ...spawn("alpha", "Alpha"),
    ...spawn("beta", "Beta", "done"),
    ...spawn("gamma", "Gamma", "failed"),
  ]);
  const agents = within(card).getByRole("region", { name: "Agents" });
  expect(within(agents).getByRole("button", { name: /^Open Alpha,/ })).toBeTruthy();
  expect(within(agents).queryByRole("button", { name: /^Open Beta,/ })).toBeNull();
  expect(within(agents).queryByRole("button", { name: /^Open Gamma,/ })).toBeNull();
  const completed = within(agents).getByRole("button", {
    name: "1 working · 1 finished · 1 failed",
  });
  expect(completed.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(completed);
  expect(completed.getAttribute("aria-expanded")).toBe("true");
  expect(within(agents).getByRole("button", { name: /^Open Beta,/ })).toBeTruthy();
  expect(within(agents).getByRole("button", { name: /^Open Gamma,/ })).toBeTruthy();
  await userEvent.click(completed);
  expect(within(agents).queryByRole("button", { name: /^Open Beta,/ })).toBeNull();
  expect(within(agents).queryByRole("button", { name: /^Open Gamma,/ })).toBeNull();
});

test("a long group shows five rows and Show N more reveals the rest", async () => {
  const agentFacts = Array.from({ length: 7 }, (_, index) =>
    spawn(`worker-${index}`, `Worker ${index + 1}`),
  ).flat();
  const { card } = await openAgents("agents-long", "Agents long", agentFacts);
  const agents = within(card).getByRole("region", { name: "Agents" });
  for (let index = 1; index <= 5; index++)
    expect(
      within(agents).getByRole("button", { name: new RegExp(`^Open Worker ${index},`) }),
    ).toBeTruthy();
  expect(within(agents).queryByRole("button", { name: /^Open Worker 6,/ })).toBeNull();
  expect(within(agents).queryByRole("button", { name: /^Open Worker 7,/ })).toBeNull();
  await userEvent.click(within(agents).getByRole("button", { name: "Show 2 more" }));
  for (let index = 1; index <= 7; index++)
    expect(
      within(agents).getByRole("button", { name: new RegExp(`^Open Worker ${index},`) }),
    ).toBeTruthy();
  expect(within(agents).queryByRole("button", { name: "Show 2 more" })).toBeNull();
});

test("the agents line puts working agents first, and counts them finished only once they all settle", async () => {
  const { app } = await openAgents("agents-two", "Some running", [
    ...spawn("a1", "A1"),
    ...spawn("a2", "A2", "done"),
    ...spawn("a3", "A3", "done"),
  ]);
  let agents = within(await openWorkCard()).getByRole("region", { name: "Agents" });
  expect(within(agents).getByRole("button", { name: "1 working · 2 finished" })).toBeTruthy();
  expect(within(agents).getByRole("heading", { name: "Agents" })).toBeTruthy();
  app.daemon.apply("agents-two", [facts.endTurn("a1")]);
  agents = within(await openWorkCard()).getByRole("region", { name: "Agents" });
  expect(await within(agents).findByRole("button", { name: "3 finished" })).toBeTruthy();
});

test("a subagent whose own turn ended stays with the running ones while its subagent still runs", async () => {
  const { card } = await openAgents("agents-nested", "Agents nested", [
    ...spawn("lead", "Lead"),
    facts.tool("lead", "spawn-helper", {
      kind: "agent.spawn",
      title: "Helper",
      detail: { kind: "agent.spawn", description: "Helper", childAgent: "helper" },
    }),
    facts.subagent("codex", "helper", "Helper", "spawn-helper", { parent: "lead" }),
    facts.turn("helper", "spawn"),
    facts.toolDone("lead", "spawn-helper"),
    facts.endTurn("lead"),
    ...spawn("scout", "Scout", "done"),
  ]);
  const agents = within(card).getByRole("region", { name: "Agents" });
  expect(within(agents).getByRole("button", { name: /^Open Lead, Waiting on/ })).toBeTruthy();
  // Lead's own turn ended, but Helper still runs under it: waiting, never finished.
  expect(within(agents).getByRole("button", { name: "1 waiting · 1 finished" })).toBeTruthy();
});

test("an Origin review can be opened and linked without offering GitHub merge or review writes", async () => {
  const repository = {
    forge: "origin" as const,
    host: "origin.cursor.com",
    owner: "acme",
    name: "relay",
  };
  const { card } = await open("changes", {
    repository,
    linkedPrs: [
      {
        repo: repository,
        number: 188,
        state: "open",
        updatedAt: 1000,
        url: "https://cursor.com/codebase/acme/relay/pull/188",
      },
    ],
  });
  expect(await within(card).findByRole("button", { name: /^Open pull request #188/ })).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Merge pull request #188" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "More git actions" }));
  expect(await screen.findByRole("menuitem", { name: "Link a pull request…" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Request review…" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Squash and merge/ })).toBeNull();
});
