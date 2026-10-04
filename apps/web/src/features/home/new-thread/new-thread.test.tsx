import { workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import {
  chooseModel,
  closeModelControl,
  openModelControl,
  openModelPicker,
} from "@/test/model-control.ts";
import { Choices } from "./choices.ts";

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

test("⌘N, a project, a model and a message start a thread that then opens", async () => {
  const made = app();
  await made.open("/");
  await screen.findByRole("navigation", { name: "Threads" });
  await userEvent.keyboard("{Meta>}n{/Meta}");
  await screen.findByRole("heading", { level: 1, name: "New thread" });

  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "relay" }));
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 4.1/);
  await closeModelControl();
  expect(
    await screen.findByRole("button", { name: "Model: GPT-5 Codex, personal, Medium effort" }),
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

/** Cursor also lists Codex's `gpt-5`, as Codex, Pi and Cursor all list `gpt-5.5` in practice. */
function cursorSharesGpt5(made: ReturnType<typeof harness>) {
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
}
const savedModel = (storage: ReturnType<typeof memoryKeyValue>) =>
  Choices.parse(JSON.parse(storage.getItem("ace.home.newThread") ?? "{}")).model;

test("a model id two providers share starts the thread on the provider it was picked under", async () => {
  const made = app();
  cursorSharesGpt5(made);
  await made.open("/new?project=relay");

  await chooseModel("GPT-5", "Cursor", /^Model: Opus 4.1/);
  const picker = await openModelPicker(
    await screen.findByRole("dialog", { name: "Model and effort" }),
  );
  await userEvent.type(screen.getByRole("combobox", { name: "Search models" }), "GPT-5");
  expect(within(picker).getByRole("option", { name: "GPT-5, Codex" }).ariaSelected).toBe("false");
  expect(within(picker).getByRole("option", { name: "GPT-5, Cursor" }).ariaSelected).toBe("true");
  await closeModelControl();

  await userEvent.type(await prompt(), "Trace the reconnect loop{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect loop" });
  const created = listed(made).find((t) => t.title === "Trace the reconnect loop");
  expect(created).toMatchObject({ provider: "cursor" });
  expect(created?.live?.model).toBe("gpt-5");
});

test("a model remembered as a bare id stays picked on the starting provider and is saved by key", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.newThread", JSON.stringify({ model: "gpt-5" }));
  const made = app({ storage });
  cursorSharesGpt5(made);
  made.daemon.services.settings.seed({ "providers.default": "codex" });
  await made.open("/new?project=relay");

  expect(
    await screen.findByRole("button", { name: "Model: GPT-5, personal, Medium effort" }),
  ).toBeTruthy();
  await waitFor(() => expect(savedModel(storage)).toBe("codex\u0000gpt-5"));
  await userEvent.type(await prompt(), "Trace the reconnect loop{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect loop" });
  const created = listed(made).find((t) => t.title === "Trace the reconnect loop");
  expect(created).toMatchObject({ provider: "codex" });
  expect(created?.live?.model).toBe("gpt-5");
  expect(savedModel(storage)).toBe("codex\u0000gpt-5");
});

test("a bare id remembered for a model the starting provider doesn't list is not claimed by another provider", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.newThread", JSON.stringify({ model: "gpt-5" }));
  const made = app({ storage });
  cursorSharesGpt5(made);
  // Claude Code starts; only Codex and Cursor list gpt-5.
  await made.open("/new?project=relay");

  expect(await screen.findByRole("button", { name: /^Model: Opus 4\.1/ })).toBeTruthy();
  expect(savedModel(storage)).toBe("gpt-5");
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
  await chooseModel("Sonnet 4.5", "Claude Code", /^Model: Opus 4\.1/);
  await userEvent.click(await screen.findByRole("button", { name: "Account work" }));
  await closeModelControl();
  await userEvent.click(screen.getByRole("button", { name: "Where the work happens: Worktree" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Local" }));
  // A worktree's base branch only applies to worktrees.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /^Start from branch/ })).toBeNull(),
  );
  cleanup();

  const made = app({ storage });
  await made.open("/new");
  expect(
    await screen.findByRole("button", { name: "Model: Sonnet 4.5, work, provider default effort" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Where the work happens: Local" })).toBeTruthy();

  await userEvent.type(await prompt(), "Trace the reconnect loop{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect loop" });
  const created = listed(made).find((t) => t.title === "Trace the reconnect loop");
  expect(created).toMatchObject({ provider: "claude", details: { mode: "local" } });
  expect(created?.live).toMatchObject({ model: "claude-sonnet-4-5", account: "claude-work" });
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
  // Model and effort share one popover: picking a model comes back to its effort.
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 4.1/);
  const popover = await screen.findByRole("dialog", { name: "Model and effort" });
  within(popover).getByRole("slider", { name: "Effort" }).focus();
  await userEvent.keyboard("{End}");
  await closeModelControl();
  expect(
    await screen.findByRole("button", { name: "Model: GPT-5 Codex, personal, High effort" }),
  ).toBeTruthy();
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

test("the speed toggle starts the thread on the model's faster tier", async () => {
  const made = app();
  await made.open("/new?project=relay");
  // Opus has no faster tier: the toggle is there, off, and says why.
  const claude = await openModelControl(/^Model: Opus 4.1/);
  const unavailable = within(claude).getByRole("button", { name: "Fast mode" });
  expect(unavailable.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(unavailable);
  expect(unavailable.getAttribute("aria-pressed")).toBe("false");
  await closeModelControl();

  await chooseModel("GPT-5 Codex", "Codex");
  const popover = await screen.findByRole("dialog", { name: "Model and effort" });
  await userEvent.click(within(popover).getByRole("button", { name: "Fast mode" }));
  expect(within(popover).getByRole("button", { name: "Fast mode" }).ariaPressed).toBe("true");
  await closeModelControl();
  expect(await screen.findByRole("button", { name: /^Model: GPT-5 Codex, .*fast$/ })).toBeTruthy();

  await userEvent.type(await prompt(), "Profile the relay startup{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Profile the relay startup" });
  const created = listed(made).find((t) => t.title === "Profile the relay startup");
  expect(created?.live?.options).toMatchObject({ serviceTier: "priority" });
});

test("reset puts effort and speed back to the model's defaults", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 4.1/);
  const popover = await screen.findByRole("dialog", { name: "Model and effort" });
  const reset = within(popover).getByRole("button", { name: "Reset effort and speed" });
  expect(reset.getAttribute("aria-disabled")).toBe("true");
  within(popover).getByRole("slider", { name: "Effort" }).focus();
  await userEvent.keyboard("{End}");
  await userEvent.click(within(popover).getByRole("button", { name: "Fast mode" }));
  expect(reset.getAttribute("aria-disabled")).toBeNull();

  await userEvent.click(reset);
  expect(within(popover).getByRole("slider", { name: "Effort" }).ariaValueText).toBe("Medium");
  expect(within(popover).getByRole("button", { name: "Fast mode" }).ariaPressed).toBe("false");
  await closeModelControl();

  await userEvent.type(await prompt(), "Profile the relay startup{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Profile the relay startup" });
  const created = listed(made).find((t) => t.title === "Profile the relay startup");
  expect(created?.live?.options).toEqual({ effort: "medium" });
});
