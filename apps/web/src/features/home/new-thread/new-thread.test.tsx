import { workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

function app(options: Parameters<typeof harness>[0] = {}) {
  const made = harness(options);
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return made;
}
const listed = (made: ReturnType<typeof harness>) => {
  const view = made.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? Object.values(view.threads) : [];
};
const prompt = () => screen.findByRole("combobox", { name: "Message" });
/** A menu that just closed still animates out; wait before opening the next. */
const menuClosed = () => waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

test("⌘N, a project, a model and a message start a thread that then opens", async () => {
  const made = app();
  await made.open("/");
  await screen.findByRole("navigation", { name: "Threads" });
  await userEvent.keyboard("{Meta>}n{/Meta}");
  await screen.findByRole("heading", { level: 1, name: "New thread" });

  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "relay" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Model: Opus 4.1/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "GPT-5 Codex" }));
  expect(
    await screen.findByRole("button", { name: "Model: GPT-5 Codex, account personal" }),
  ).toBeTruthy();

  const field = await prompt();
  expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBe("true");
  await userEvent.type(field, "Log every restart with its backoff delay{Enter}");

  // The daemon created it from the request, and the app opened it.
  await screen.findByRole("heading", {
    level: 1,
    name: "Log every restart with its backoff delay",
  });
  const created = listed(made).find((t) => t.title === "Log every restart with its backoff delay");
  expect(created).toMatchObject({ workspaceId: "relay", provider: "codex" });
  const nav = screen.getByRole("navigation", { name: "Threads" });
  expect(within(nav).getByRole("link", { name: /Log every restart/ })).toBeTruthy();
});

test("a model id two providers share starts the thread on the provider it was picked under", async () => {
  const made = app();
  const { services } = made.daemon;
  const codexGpt5 = services.models.find(
    (m) => m.provider === "codex" && m.nativeModelId === "gpt-5",
  );
  if (!codexGpt5) throw new Error("fixture lists Codex GPT-5");
  services.models.push({
    ...codexGpt5,
    id: "cursor:gpt-5",
    provider: "cursor",
    instance: "cursor",
  });
  await made.open("/new?project=relay");

  await userEvent.click(await screen.findByRole("button", { name: /^Model: Opus 4.1/ }));
  const cursor = await screen.findByRole("group", { name: "Cursor" });
  await userEvent.click(within(cursor).getByRole("menuitemradio", { name: "GPT-5" }));
  const codex = screen.getByRole("group", { name: "Codex" });
  expect(within(codex).getByRole("menuitemradio", { name: "GPT-5" }).ariaChecked).toBe("false");
  expect(within(cursor).getByRole("menuitemradio", { name: "GPT-5" }).ariaChecked).toBe("true");
  await userEvent.keyboard("{Escape}");
  await menuClosed();

  await userEvent.type(await prompt(), "Trace the reconnect loop{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect loop" });
  const created = listed(made).find((t) => t.title === "Trace the reconnect loop");
  expect(created).toMatchObject({ provider: "cursor" });
});

test("Shift+Enter writes a new line instead of sending", async () => {
  const made = app();
  await made.open("/new");
  const field = await prompt();
  await userEvent.type(field, "First line{Shift>}{Enter}{/Shift}second line");
  expect((field as HTMLTextAreaElement).value).toBe("First line\nsecond line");
  expect(listed(made)).toHaveLength(workbench().length);
});

test("the last model, account and work mode are remembered for the next thread", async () => {
  const storage = memoryKeyValue();
  await app({ storage }).open("/new?project=ace");
  await userEvent.click(await screen.findByRole("button", { name: /^Model:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Account work" }));
  await userEvent.click(screen.getByRole("button", { name: "Where the work happens: Worktree" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Local" }));
  // A worktree's base branch only applies to worktrees.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /^Start from branch/ })).toBeNull(),
  );
  cleanup();

  await app({ storage }).open("/new");
  expect(await screen.findByRole("button", { name: "Model: Opus 4.1, account work" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Where the work happens: Local" })).toBeTruthy();
});

test("⌘N and the sidebar's New thread start in the project Home is narrowed to, before the last one used", async () => {
  const storage = memoryKeyValue();
  // The last thread was started in ace.
  storage.setItem("ace.home.newThread", JSON.stringify({ project: "ace" }));
  await app({ storage }).open("/new");
  await screen.findByRole("heading", { name: "What should we work on in ace?" });

  await userEvent.click(
    await screen.findByRole("button", { name: "Project filter: All projects" }),
  );
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "relay" }));
  await userEvent.click(screen.getByRole("link", { name: /^Activity/ }));
  await screen.findByRole("heading", { level: 1, name: "Activity" });
  await userEvent.keyboard("{Meta>}n{/Meta}");
  await screen.findByRole("heading", { name: "What should we work on in relay?" });

  await userEvent.click(screen.getByRole("link", { name: /^Activity/ }));
  await screen.findByRole("heading", { level: 1, name: "Activity" });
  await userEvent.click(screen.getByRole("link", { name: /^New thread/ }));
  await screen.findByRole("heading", { name: "What should we work on in relay?" });
});

test("a worktree thread starts from the chosen branch, on the chosen account and effort", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await userEvent.click(await screen.findByRole("button", { name: /^Model: Opus 4.1/ }));
  // Model, account and effort share one menu, which stays open while choosing.
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "GPT-5 Codex" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "High effort" }));
  await userEvent.keyboard("{Escape}");
  await menuClosed();
  await userEvent.click(await screen.findByRole("button", { name: /^Start from branch/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "develop" }));

  await userEvent.type(await prompt(), "Add jitter to the retry backoff{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Add jitter to the retry backoff" });
  const created = listed(made).find((t) => t.title === "Add jitter to the retry backoff");
  expect(created?.details).toMatchObject({ mode: "worktree", baseBranch: "develop" });
  expect(created?.live).toMatchObject({ account: "codex-personal", options: { effort: "high" } });
});

test("files and @ mentions work before the thread exists and arrive with it", async () => {
  const made = app();
  await made.open("/new?project=relay");
  const field = await prompt();
  await userEvent.type(field, "Explain @replay");
  const files = await screen.findByRole("listbox", { name: "Files" });
  expect(within(files).getAllByRole("option")[0]?.textContent).toContain("replay.ts");
  await userEvent.keyboard("{Enter}");

  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["2026-10-03 resume seq 0"], "relay.log", { type: "text/plain" }),
  );
  const chips = screen.getByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("status")).toBeNull());
  expect(within(chips).queryByText(/couldn't/i)).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  const heading = await screen.findByRole("heading", { level: 1, name: /^Explain @/ });
  const created = listed(made).find((t) => t.title === heading.textContent);
  if (!created) throw new Error("no thread");
  const reply = await made.client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: created.id },
  });
  expect(
    reply.result.kind === "attachments" && reply.result.attachments.map((a) => a.name),
  ).toEqual(["relay.log"]);
});

test("slash commands are offered before the thread exists, for the chosen provider", async () => {
  await app().open("/new?project=relay");
  const field = await prompt();
  await userEvent.type(field, "/");
  const commands = await screen.findByRole("listbox", { name: "Commands" });
  const first = within(commands).getAllByRole("option")[0];
  expect(first?.textContent).toMatch(/^\//);
  await userEvent.keyboard("{Tab}");
  expect((field as HTMLTextAreaElement).value).toMatch(/^\/\S+ $/);
});

test("approvals chosen for a new thread are the ones it starts with", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await userEvent.click(await screen.findByRole("button", { name: "Approvals: Auto-review" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Ask first" }));
  expect(await screen.findByRole("button", { name: "Approvals: Ask first" })).toBeTruthy();

  await userEvent.type(await prompt(), "Audit the retry budget{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Audit the retry budget" });
  expect(await screen.findByRole("button", { name: /^Approvals: Ask first/ })).toBeTruthy();
});

test("an unsent New thread draft waits for the next visit, and goes once the thread starts", async () => {
  const storage = memoryKeyValue();
  await app({ storage }).open("/new?project=relay");
  await userEvent.type(await prompt(), "Trace the reconnect storm");
  cleanup();

  await app({ storage }).open("/new?project=relay");
  const field = await prompt();
  expect((field as HTMLTextAreaElement).value).toBe("Trace the reconnect storm");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect storm" });
  cleanup();

  await app({ storage }).open("/new?project=relay");
  expect(((await prompt()) as HTMLTextAreaElement).value).toBe("");
});
