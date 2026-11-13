import { fakeFileRevision, type FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryHistory } from "@tanstack/react-router";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function withWriter(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return api.addAgent({ id: "writer", name: "Writer" });
}

/** A reply that proposed a skill with call `p1`, and the proposal Spade keeps for it. */
function proposed(api: FakeSpadeApi, base?: { description: string; body: string }) {
  const writer = withWriter(api);
  api.store(writer.conversation, { type: "user_message", text: "Write the notes" });
  api.store(writer.conversation, { type: "reply_started", reply: "r1" });
  api.store(writer.conversation, {
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: [{ id: "p1", name: "skill_propose" }],
  });
  api.store(writer.conversation, { type: "tool_started", reply: "r1", call_id: "p1" });
  api.store(writer.conversation, {
    type: "tool_finished",
    reply: "r1",
    call_id: "p1",
    content: "Proposed.",
  });
  api.store(writer.conversation, { type: "step_finished", reply: "r1", text: "Done." });
  api.store(writer.conversation, { type: "reply_finished", reply: "r1", text: "Done." });
  api.proposals.set("writer", [
    {
      id: "sp_1",
      call_id: "p1",
      name: "release-notes",
      description: "Write release notes from merged pull requests",
      body: "List merged PRs.\nGroup by area.",
      why: "You asked me to group by area.",
      base: base ? { id: "skl_1", hash: "a", manual: false, ...base } : null,
      state: "open",
      created_at: 1,
    },
  ]);
}

async function skillBubble() {
  const group = await screen.findByRole("group", { name: "Skill release-notes" });
  return within(group);
}

test("a proposed skill is the bot's bubble, and Save sends it to the library", async () => {
  const { spade } = await spadeApp("/spade", (api) => proposed(api));
  await userEvent.click(await botRow("Writer"));
  const bubble = await skillBubble();
  bubble.getByText("You asked me to group by area.");
  expect(bubble.queryByLabelText("Skill text")).toBeNull();
  await userEvent.click(bubble.getByRole("button", { name: "Show skill" }));
  expect(bubble.getByLabelText("Skill text").textContent).toBe("List merged PRs.\nGroup by area.");
  await userEvent.click(bubble.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/writer/skill-proposals/sp_1")).toEqual([{ save: true }]),
  );
  await bubble.findByText("Saved to your skills");
  expect(bubble.queryByRole("button", { name: "Save" })).toBeNull();
});

test("Discard answers the proposal without saving it", async () => {
  const { spade } = await spadeApp("/spade", (api) => proposed(api));
  await userEvent.click(await botRow("Writer"));
  const bubble = await skillBubble();
  await userEvent.click(bubble.getByRole("button", { name: "Discard" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/writer/skill-proposals/sp_1")).toEqual([{ save: false }]),
  );
  await bubble.findByText("Discarded");
});

test("an edit of a skill shows the lines that change", async () => {
  await spadeApp("/spade", (api) =>
    proposed(api, {
      description: "Write release notes from merged pull requests",
      body: "List merged PRs.",
    }),
  );
  await userEvent.click(await botRow("Writer"));
  const bubble = await skillBubble();
  bubble.getByText(/suggests a change to the skill/);
  await userEvent.click(bubble.getByRole("button", { name: "Show changes" }));
  const changes = bubble.getByLabelText("Changes");
  expect(changes.textContent).toContain("Added: Group by area.");
  expect(changes.textContent).not.toContain("Removed:");
});

test("a command the bot wants to run shows itself, and can be allowed always as it is", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.ask(writer, "k1", "shell", { command: "npm test" });
  });
  await userEvent.click(await botRow("Writer"));
  const request = within(
    await screen.findByRole("group", { name: "Writer wants to run a command" }),
  );
  await userEvent.click(request.getByRole("button", { name: "Review" }));
  expect(request.getByLabelText("Command").textContent).toBe("npm test");
  await userEvent.click(request.getByRole("button", { name: "Always allow this command" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-writer/approvals/k1")).toEqual([
      { allowed: true, always: true },
    ]),
  );
});

test("Files lists the bot's folder, opens a file and deletes after confirming", async () => {
  const { spade } = await spadeApp("/spade/writer", (api) => {
    withWriter(api);
    api.files.set("writer", { "notes/plan.md": "# Plan\nShip it.", "todo.txt": "milk" });
  });
  await screen.findByRole("feed", { name: "Conversation with Writer" });
  // From the bot's page: its Files, all of them.
  await userEvent.click(await screen.findByRole("link", { name: /^Writer on .*open its page$/ }));
  const section = within(await screen.findByRole("region", { name: "Files" }));
  await userEvent.click(section.getByRole("button", { name: "All" }));
  // Changing files needs the person driving.
  await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
  await screen.findByRole("button", { name: "Hand back" });
  const files = within(await screen.findByRole("list", { name: "Files" }));
  expect(files.getAllByRole("listitem").map((row) => row.textContent?.split(/\d/)[0])).toEqual([
    expect.stringContaining("notes"),
    expect.stringContaining("todo.txt"),
  ]);

  await userEvent.click(files.getByRole("button", { name: /^notes/ }));
  const inner = within(await screen.findByRole("list", { name: "Files" }));
  await userEvent.click(await inner.findByRole("button", { name: /^plan\.md/ }));
  const opened = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "notes/plan.md" });
  await waitFor(() => expect(opened.value).toBe("# Plan\nShip it."));

  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Folder" })).getByText("Files"),
  );
  const top = within(await screen.findByRole("list", { name: "Files" }));
  const todo = top.getAllByRole("listitem").find((row) => row.textContent?.includes("todo.txt"));
  if (!todo) throw new Error("no todo.txt row");
  await userEvent.click(within(todo).getByRole("button", { name: "More for todo.txt" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const confirm = within(await screen.findByRole("dialog", { name: "Delete todo.txt?" }));
  await userEvent.click(confirm.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(
      spade.requests
        .filter((request) => request.method === "DELETE" && request.path.includes("/workspace"))
        .map((request) => request.path),
    ).toEqual([`/v1/agents/writer/workspace?path=todo.txt&base=${fakeFileRevision("milk")}`]),
  );
  await waitFor(() => expect(screen.queryByText("todo.txt")).toBeNull());
});

test("moving to another folder closes the open file, and Delete names the file's path", async () => {
  const history = createMemoryHistory({ initialEntries: ["/spade/writer?files=notes"] });
  await spadeApp(
    "/spade/writer?files=notes",
    (api) => {
      withWriter(api);
      api.files.set("writer", { "notes/plan.md": "# Plan", "todo.txt": "milk" });
    },
    { history },
  );
  await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
  await screen.findByRole("button", { name: "Hand back" });
  const inner = within(await screen.findByRole("list", { name: "Files" }));
  const plan = (await inner.findAllByRole("listitem")).find((row) =>
    row.textContent?.includes("plan.md"),
  );
  if (!plan) throw new Error("no plan.md row");
  await userEvent.click(within(plan).getByRole("button", { name: "More for plan.md" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const confirm = await screen.findByRole("dialog", { name: "Delete plan.md?" });
  expect(confirm.textContent).toContain("This deletes notes/plan.md from Writer's files.");
  await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

  await userEvent.click(within(plan).getByRole("button", { name: /^plan\.md/ }));
  await screen.findByLabelText("notes/plan.md");
  history.push("/spade/writer?files=.");
  const top = within(await screen.findByRole("list", { name: "Files" }));
  await top.findByRole("button", { name: /^todo\.txt/ });
  expect(screen.queryByLabelText("notes/plan.md")).toBeNull();
});

test("a proposal answered meanwhile shows as answered after Save is refused", async () => {
  const { spade } = await spadeApp("/spade", (api) => proposed(api));
  await userEvent.click(await botRow("Writer"));
  const bubble = await skillBubble();
  // Saved already (another window, or a Save whose answer was lost).
  const kept = spade.proposals.get("writer")?.[0];
  if (kept) kept.state = "saved";
  await userEvent.click(bubble.getByRole("button", { name: "Save" }));
  await bubble.findByText("Saved to your skills");
  expect(bubble.queryByRole("button", { name: "Save" })).toBeNull();
});

test("a proposal written after reading a page says so beside Save", async () => {
  await spadeApp("/spade", (api) => {
    proposed(api);
    const kept = api.proposals.get("writer")?.[0];
    if (kept) kept.source = "https://example.com/tips";
  });
  await userEvent.click(await botRow("Writer"));
  const bubble = await skillBubble();
  bubble.getByText("Written after reading https://example.com/tips");
});
