import { workbench } from "@ace/fake-daemon";
import { CatalogModel } from "@ace/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
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
/**
 * The thread this page started: it opens at once, and the daemon lists it once its create
 * lands, under an id made from the command's (the daemon titles it from the message).
 */
const isNew = (id: string) => /^thread-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id);
async function started(made: ReturnType<typeof harness>) {
  await waitFor(() => expect(listed(made).some((t) => isNew(t.id))).toBe(true));
  return listed(made).find((t) => isNew(t.id));
}

test("⌘N, a project, a model and a message start a thread that then opens", async () => {
  const made = app();
  await made.open("/");
  await screen.findByRole("navigation", { name: "Threads" });
  await userEvent.keyboard("{Meta>}n{/Meta}");
  await screen.findByRole("heading", { level: 1, name: "New thread" });

  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "relay" }));
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 5.5/);
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
  const created = await started(made);
  expect(created).toMatchObject({ workspaceId: "relay", provider: "codex" });
  const nav = screen.getByRole("navigation", { name: "Threads" });
  expect(within(nav).getByRole("link", { name: /Log every restart/ })).toBeTruthy();
});

/** Cursor also lists Codex's `gpt-6`, as Codex, Pi and Cursor all list `gpt-5.5` in practice. */
function cursorSharesGpt6(made: ReturnType<typeof harness>) {
  const { services } = made.daemon;
  const codexGpt6 = services.models.find(
    (m) => m.provider === "codex" && m.nativeModelId === "gpt-6",
  );
  if (!codexGpt6) throw new Error("fixture lists Codex GPT-6");
  services.models.push({ ...codexGpt6, provider: "cursor", instance: "cursor", isDefault: false });
}
const savedModel = (storage: ReturnType<typeof memoryKeyValue>) =>
  Choices.parse(JSON.parse(storage.getItem("ace.home.newThread") ?? "{}")).model;

test("a model id two providers share starts the thread on the provider it was picked under", async () => {
  const made = app();
  cursorSharesGpt6(made);
  await made.open("/new?project=relay");

  await chooseModel("GPT-6", "Cursor", /^Model: Opus 5.5/);
  const picker = await openModelPicker(
    await screen.findByRole("dialog", { name: "Model and effort" }),
  );
  await userEvent.type(screen.getByRole("combobox", { name: "Search models" }), "GPT-6");
  expect(within(picker).getByRole("option", { name: "GPT-6, Codex" }).ariaSelected).toBe("false");
  expect(within(picker).getByRole("option", { name: "GPT-6, Cursor" }).ariaSelected).toBe("true");
  await closeModelControl();

  await userEvent.type(await prompt(), "Trace the reconnect loop{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect loop" });
  const created = await started(made);
  expect(created).toMatchObject({ provider: "cursor" });
  expect(created?.live?.model).toBe("gpt-6");
});

test("a model remembered as a bare id stays picked on the starting provider and is saved by key", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.newThread", JSON.stringify({ model: "gpt-6" }));
  const made = app({ storage });
  cursorSharesGpt6(made);
  made.daemon.services.settings.seed({ "providers.default": "codex" });
  await made.open("/new?project=relay");

  expect(
    await screen.findByRole("button", { name: "Model: GPT-6, personal, Medium effort" }),
  ).toBeTruthy();
  await waitFor(() => expect(savedModel(storage)).toBe("codex\u0000gpt-6"));
  await userEvent.type(await prompt(), "Trace the reconnect loop{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect loop" });
  const created = await started(made);
  expect(created).toMatchObject({ provider: "codex" });
  expect(created?.live?.model).toBe("gpt-6");
  expect(savedModel(storage)).toBe("codex\u0000gpt-6");
});

test("a bare id remembered for a model the starting provider doesn't list is not claimed by another provider", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.newThread", JSON.stringify({ model: "gpt-6" }));
  const made = app({ storage });
  cursorSharesGpt6(made);
  // Claude Code starts; only Codex and Cursor list gpt-6.
  await made.open("/new?project=relay");

  expect(await screen.findByRole("button", { name: /^Model: Opus 5\.5/ })).toBeTruthy();
  expect(savedModel(storage)).toBe("gpt-6");
});

/**
 * Personal keeps the built-in default (Opus 5.5); work's synced default is Sonnet 4.5, a legacy
 * model the person chose in Settings, which still starts as that account's default.
 */
function workDefaultsToSonnet(made: ReturnType<typeof harness>) {
  made.daemon.services.settings.seed({
    "providers.configuration": [
      { provider: "claude", instance: "claude-work", defaultModel: "claude-sonnet-4-5" },
    ],
  });
}

test("picking the work account launches the work account's own default, not the personal one", async () => {
  const made = app();
  workDefaultsToSonnet(made);
  await made.open("/new?project=relay");

  const popover = await openModelControl(/^Model: Opus 5\.5, personal/);
  await userEvent.click(within(popover).getByRole("button", { name: "Account work" }));
  await closeModelControl();
  expect(await screen.findByRole("button", { name: /^Model: Sonnet 4\.5, work/ })).toBeTruthy();

  await userEvent.type(await prompt(), "Trace the reconnect loop{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect loop" });
  const created = await started(made);
  expect(created?.live).toMatchObject({ model: "claude-sonnet-4-5", account: "claude-work" });
});

test("a remembered account starts on that account's default without a model being picked", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.newThread", JSON.stringify({ account: "claude-work" }));
  const made = app({ storage });
  workDefaultsToSonnet(made);
  await made.open("/new?project=relay");

  expect(await screen.findByRole("button", { name: /^Model: Sonnet 4\.5, work/ })).toBeTruthy();
  await userEvent.type(await prompt(), "Audit the retry budget{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Audit the retry budget" });
  const created = await started(made);
  expect(created?.live).toMatchObject({ model: "claude-sonnet-4-5", account: "claude-work" });
});

test("an OpenCode default starts the thread with its qualified provider/model id", async () => {
  const made = app();
  const { services } = made.daemon;
  const template = services.models.find((row) => row.provider === "opencode");
  if (!template) throw new Error("fixture lists an OpenCode model");
  // The catalog id is qualified; the native id beside its provider is bare.
  services.models = [
    ...services.models.filter((row) => row.provider !== "opencode"),
    CatalogModel.parse({
      ...template,
      id: "opencode-go/muse-spark-1.3-contributor",
      displayName: "Muse Spark 1.3",
      nativeProviderId: "opencode-go",
      nativeModelId: "muse-spark-1.3-contributor",
      isDefault: true,
    }),
  ];
  services.settings.seed({ "providers.default": "opencode" });
  await made.open("/new?project=relay");

  expect(await screen.findByRole("button", { name: /^Model: Muse Spark 1\.3/ })).toBeTruthy();
  await userEvent.type(await prompt(), "Map the session lifecycle{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Map the session lifecycle" });
  const created = await started(made);
  expect(created).toMatchObject({ provider: "opencode" });
  expect(created?.live?.model).toBe("opencode-go/muse-spark-1.3-contributor");
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
  await chooseModel("Sonnet 5.5", "Claude Code", /^Model: Opus 5\.5/);
  await userEvent.click(await screen.findByRole("button", { name: "Account work" }));
  await closeModelControl();
  const worktree = await screen.findByRole("checkbox", { name: "Worktree" });
  expect(worktree.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(worktree);
  // The local checkout is the whole choice: no branch to start from.
  expect(worktree.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByRole("button", { name: /^Start from:/ })).toBeNull();
  cleanup();

  const made = app({ storage });
  await made.open("/new");
  expect(
    await screen.findByRole("button", { name: "Model: Sonnet 5.5, work, provider default effort" }),
  ).toBeTruthy();
  expect(
    (await screen.findByRole("checkbox", { name: "Worktree" })).getAttribute("aria-checked"),
  ).toBe("false");

  await userEvent.type(await prompt(), "Trace the reconnect loop{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect loop" });
  const created = await started(made);
  expect(created).toMatchObject({ provider: "claude", details: { mode: "local" } });
  expect(created?.live).toMatchObject({ model: "claude-sonnet-5-5", account: "claude-work" });
});

test("⌘N and the sidebar's New thread start in the project Home is narrowed to, before the last one used", async () => {
  const storage = memoryKeyValue();
  // The last thread was started in ace.
  storage.setItem("ace.home.newThread", JSON.stringify({ project: "ace" }));
  await app({ storage }).open("/new");
  await screen.findByRole("button", { name: "Project: ace" });

  await userEvent.click(
    await screen.findByRole("button", { name: "Project filter: All projects" }),
  );
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "relay" }));
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "App" })).getByRole("link", {
      name: /^Activity/,
    }),
  );
  await screen.findByRole("heading", { level: 1, name: "Activity" });
  await userEvent.keyboard("{Meta>}n{/Meta}");
  await screen.findByRole("button", { name: "Project: relay" });

  await userEvent.click(
    within(screen.getByRole("navigation", { name: "App" })).getByRole("link", {
      name: /^Activity/,
    }),
  );
  await screen.findByRole("heading", { level: 1, name: "Activity" });
  await userEvent.click(screen.getByRole("link", { name: /^New thread/ }));
  await screen.findByRole("button", { name: "Project: relay" });
});

test("a worktree thread starts from the chosen branch, on the chosen account and effort", async () => {
  const made = app();
  await made.open("/new?project=relay");
  // Model and effort share one popover: picking a model comes back to its effort.
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 5.5/);
  const popover = await screen.findByRole("dialog", { name: "Model and effort" });
  within(popover).getByRole("slider", { name: "Effort" }).focus();
  await userEvent.keyboard("{End}");
  await closeModelControl();
  expect(
    await screen.findByRole("button", { name: "Model: GPT-5 Codex, personal, High effort" }),
  ).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: /^Start from:/ }));
  await userEvent.type(await screen.findByRole("combobox", { name: "Start from branch" }), "dev");
  const local = await screen.findByRole("group", { name: "Local" });
  await userEvent.click(within(local).getByRole("option", { name: /^develop/ }));
  expect(await screen.findByRole("button", { name: "Start from: develop" })).toBeTruthy();

  await userEvent.type(await prompt(), "Add jitter to the retry backoff{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Add jitter to the retry backoff" });
  const created = await started(made);
  expect(created?.details).toMatchObject({
    mode: "worktree",
    baseBranch: "develop",
    base: { ref: "develop" },
  });
  expect(created?.live).toMatchObject({ account: "codex-personal", options: { effort: "high" } });
});

test("a new worktree starts from the remote's fresh default branch unless another is picked", async () => {
  const made = app();
  await made.open("/new?project=relay");
  // The local main is behind origin's: the fresher remote copy is the default.
  const from = await screen.findByRole("button", { name: "Start from: origin/main" });
  await userEvent.click(from);
  const card = await screen.findByRole("dialog", { name: "Start from a branch" });
  const remote = within(card).getByRole("group", { name: "On origin" });
  expect(within(remote).getByRole("option", { name: /^origin\/main/ }).textContent).toContain(
    "default",
  );
  const local = within(card).getByRole("group", { name: "Local" });
  expect(within(local).getByRole("option", { name: /^main/ }).textContent).toContain(
    "2 behind origin",
  );

  // A branch only the remote has is found by typing, and picked with the keyboard.
  await userEvent.type(within(card).getByRole("combobox", { name: "Start from branch" }), "login");
  expect(
    within(card)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["origin/fix/login-timeout"]);
  await userEvent.keyboard("{Enter}");
  expect(
    await screen.findByRole("button", { name: "Start from: origin/fix/login-timeout" }),
  ).toBeTruthy();
  expect(document.activeElement).toBe(await prompt());

  await userEvent.type(await prompt(), "Retry the login after a timeout{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Retry the login after a timeout" });
  const created = await started(made);
  expect(created?.details).toMatchObject({
    mode: "worktree",
    baseBranch: "origin/fix/login-timeout",
    base: { ref: "fix/login-timeout", remote: "origin", fetch: "fetched" },
  });
});

test("when the remote can't be reached, the thread starts from the last fetched copy and says so", async () => {
  const made = app();
  made.daemon.setRemoteReachable(false);
  await made.open("/new?project=relay");
  await screen.findByRole("button", { name: "Start from: origin/main" });
  await userEvent.type(await prompt(), "Bump the retry budget{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Bump the retry budget" });

  const created = await started(made);
  expect(created?.details?.base).toMatchObject({ remote: "origin", fetch: "unreachable" });
  // Once its agent is stopped, the composer's tab shows where it runs, and raises the details.
  await userEvent.click(await screen.findByRole("button", { name: "Stop the agent" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Environment: Worktree/ }));
  const card = await screen.findByRole("region", { name: "Where this thread runs" });
  expect(within(card).getByText(/^origin\/main at [0-9a-f]{7}$/)).toBeTruthy();
  expect(
    within(card).getByText("origin couldn't be reached, so it started from the last fetched copy."),
  ).toBeTruthy();
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
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  expect(within(chips).queryByText(/couldn't/i)).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  // The header reads the provisional title at once: prose only, the mention left out.
  await screen.findByRole("heading", { level: 1, name: "Explain" });
  const created = await started(made);
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

test("a default of Ask first falls back visibly on Cursor, which can't pause for approval", async () => {
  const made = app();
  cursorSharesGpt6(made);
  made.daemon.services.settings.seed({ "permissions.defaultMode": "ask" });
  await made.open("/new?project=relay");
  expect(await screen.findByRole("button", { name: "Approvals: Ask first" })).toBeTruthy();

  await chooseModel("GPT-6", "Cursor", /^Model: Opus 5.5/);
  await closeModelControl();
  const chip = await screen.findByRole("button", { name: "Approvals: Read only" });
  expect(chip.getAttribute("aria-description")).toBe(
    "Cursor can't pause for your approval, so the thread starts in Read only",
  );
  await userEvent.click(chip);
  const ask = await screen.findByRole("menuitemradio", { name: "Ask first" });
  expect(ask.getAttribute("aria-disabled")).toBe("true");
  expect(ask.textContent).toContain("Cursor can't pause for your approval");
  await userEvent.click(ask);
  await userEvent.keyboard("{Escape}");

  // The thread starts (the daemon refuses Ask for Cursor) in the mode the chip showed.
  await userEvent.type(await prompt(), "Trace the reconnect loop{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect loop" });
  expect(await started(made)).toMatchObject({ provider: "cursor" });
  expect(await screen.findByRole("button", { name: /^Approvals: Read only/ })).toBeTruthy();
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
  const claude = await openModelControl(/^Model: Opus 5.5/);
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
  const created = await started(made);
  expect(created?.live?.options).toMatchObject({ serviceTier: "priority" });
});

test("reset puts effort and speed back to the model's defaults", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 5.5/);
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
  const created = await started(made);
  expect(created?.live?.options).toEqual({ effort: "medium" });
});

test("Enter opens the new thread at once with the message as its first bubble, even offline", async () => {
  const made = app();
  await made.open("/new?project=relay");
  const field = await prompt();
  act(() => made.daemon.refuseConnections(true));
  await waitFor(() => expect(made.client.state).not.toBe("ready"));

  await userEvent.type(field, "Trace the **reconnect** storm @src/relay.ts{Enter}");
  // The header reads the provisional title; the message is the first bubble, on its way.
  await screen.findByRole("heading", { level: 1, name: "Trace the reconnect storm" });
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(within(feed).getByText("Trace the **reconnect** storm @src/relay.ts")).toBeTruthy();
  expect(within(feed).getByText("Will apply when reconnected")).toBeTruthy();
  expect(screen.getByRole("status", { name: /^(Preparing worktree|Starting .+)…$/ })).toBeTruthy();
  expect(listed(made)).toHaveLength(workbench().length);
  // The sidebar has it at the top already, dimmed until the daemon accepts it.
  const starting = await screen.findByRole("list", { name: "Starting threads" });
  expect(within(starting).getByRole("link", { name: /^Trace the reconnect storm/ })).toBeTruthy();

  // Once the daemon has it, the real thread opens on the same message, shown once.
  act(() => made.daemon.refuseConnections(false));
  const created = await started(made);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toBeTruthy(), {
    timeout: 8_000,
  });
  expect(created).toMatchObject({ workspaceId: "relay" });
  const opened = screen.getByRole("feed", { name: "Transcript" });
  expect(within(opened).getAllByText("Trace the **reconnect** storm @src/relay.ts")).toHaveLength(
    1,
  );
});
