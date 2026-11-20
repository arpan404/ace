import { fakeFileRevision, type FakeSpadeApi } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import { botAtWork, botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const staybook = "https://www.staybook.com/lisbon?max=180";

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return spade.addAgent({ id: "scout", name: "Scout" });
}

/** Scout at work in its terminal. */
function usingTerminal(spade: FakeSpadeApi) {
  seed(spade);
  botAtWork(spade, "scout");
  spade.computer.use("scout", { kind: "terminal", live: true, title: "fares.py" });
}

/** Scout at work in its browser. */
function browsing(spade: FakeSpadeApi) {
  seed(spade);
  botAtWork(spade, "scout", "browser_act");
  spade.computer.use("scout", { kind: "browser", live: true, title: "Hotels", url: staybook });
}

const decoded = (body: Record<string, unknown>) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(String(body.data_b64)), (char) => char.charCodeAt(0)),
  );

/** Pretend the window is a phone's: media queries answer for `width`. */
function phoneWindow(width = 390) {
  const before = { width: globalThis.innerWidth, matchMedia: globalThis.matchMedia };
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: width });
  globalThis.matchMedia = (query: string) =>
    ({
      matches: [...query.matchAll(/\((min|max)-width:\s*([\d.]+)rem\)/g)].some(([, bound, rem]) =>
        bound === "min" ? width >= Number(rem) * 16 : width <= Number(rem) * 16,
      ),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) satisfies MediaQueryList;
  onTestFinished(() => {
    globalThis.matchMedia = before.matchMedia;
    Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: before.width });
  });
}

test("Computer shows only the surfaces the bot has used, its live one marked, with no tile in the chat", async () => {
  const { spade } = await spadeApp("/spade/scout?profile=computer", seed);
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  // Never used: one line, and no switcher.
  await profile.findByText("Scout hasn't used its computer yet.");
  expect(profile.queryByRole("tablist", { name: "Computer" })).toBeNull();

  botAtWork(spade, "scout", "browser_act");
  spade.computer.use("scout", { kind: "browser", live: true, title: "Hotels", url: staybook });
  const tabs = await profile.findByRole("tablist", { name: "Computer" });
  await waitFor(() =>
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Browser, in use", "Activity"]),
  );
  expect(screen.queryByRole("region", { name: /live$/ })).toBeNull();
  expect(profile.getByText("Scout's browser")).toBeTruthy();

  // Done with it, it stays listed as used, no longer live.
  spade.computer.use("scout", { kind: "browser", live: false, title: null, url: staybook });
  await within(tabs).findByRole("tab", { name: "Browser" });
});

test("while the computer starts, Computer says it is waking up", async () => {
  const { spade } = await spadeApp("/spade/scout?profile=computer", seed);
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  await profile.findByText("Scout hasn't used its computer yet.");
  spade.computer.waking("scout", true);
  await profile.findByText("Waking up…");
  spade.computer.waking("scout", false);
  await profile.findByText("Scout hasn't used its computer yet.");
});

test("Watch on the working line opens the panel on what the bot uses, without taking over", async () => {
  const { spade } = await spadeApp("/spade/scout", (api) => {
    const scout = seed(api);
    api.store(scout.conversation, { type: "user_message", text: "Find a hotel." });
    api.store(scout.conversation, { type: "reply_started", reply: "r1" });
    api.status(scout, "working", "Comparing hotels");
    api.computer.use("scout", { kind: "browser", live: true, title: "Hotels", url: staybook });
  });
  await userEvent.click(await screen.findByRole("button", { name: "Watch" }));
  const tabs = await screen.findByRole("tablist", { name: "Computer" });
  expect(
    within(tabs)
      .getByRole("tab", { name: /^Browser/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
  // Open, Watch has nothing more to show.
  expect(screen.queryByRole("button", { name: "Watch" })).toBeNull();
  expect(spade.requests.some((request) => request.path.includes("take-over"))).toBe(false);
});

test("the profile opens beside the chat, and opens again on the tab and view left for that bot", async () => {
  await spadeApp("/spade/scout", (api) => {
    browsing(api);
    api.addAgent({ id: "mail", name: "Mail" });
  });
  await userEvent.click(await screen.findByRole("button", { name: "Open Scout's profile" }));
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  expect(profile.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
  // The chat stays beside it.
  expect(screen.getByRole("combobox", { name: "Message Scout" })).toBeTruthy();
  await userEvent.click(profile.getByRole("tab", { name: "Computer" }));
  const tabs = await profile.findByRole("tablist", { name: "Computer" });
  expect(screen.getByLabelText("Address").textContent).toContain("staybook.com");
  await userEvent.click(within(tabs).getByRole("tab", { name: "Activity" }));

  // Another bot's profile is its own; back at Scout's, it is open where it was left.
  await userEvent.click(await botRow("Mail"));
  await screen.findByRole("feed", { name: "Conversation with Mail" });
  expect(screen.queryByRole("region", { name: "Scout's profile" })).toBeNull();
  await userEvent.click(await botRow("Scout"));
  const again = await screen.findByRole("tablist", { name: "Computer" });
  await waitFor(() =>
    expect(within(again).getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe(
      "true",
    ),
  );

  // Closed, it stays closed when Scout's chat opens again.
  await userEvent.click(screen.getByRole("button", { name: "Close profile" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Scout's profile" })).toBeNull());
  await userEvent.click(await botRow("Mail"));
  await screen.findByRole("feed", { name: "Conversation with Mail" });
  await userEvent.click(await botRow("Scout"));
  await screen.findByRole("feed", { name: "Conversation with Scout" });
  expect(screen.queryByRole("region", { name: "Scout's profile" })).toBeNull();
});

test("a terminal used lately while the bot is idle offers no Take over and says it isn't in use", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=terminal", (api) => {
    const scout = seed(api);
    // Spade keeps a surface live for a while after the bot's last command.
    api.computer.use("scout", { kind: "terminal", live: true, title: "rm -rf old-drafts" });
    api.reply(scout, "Done.");
  });
  const panel = await screen.findByRole("tabpanel", { name: "Terminal" });
  await screen.findByText("Scout isn't using the terminal now.");
  expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  expect(screen.queryByText("Scout is using the terminal")).toBeNull();
  expect(screen.getByRole("tab", { name: "Terminal" }).textContent).toBe("Terminal");
  expect(within(panel).queryByRole("status")).toBeNull();

  // Back at work in it: the line says so, with Take over.
  botAtWork(spade, "scout");
  await screen.findByText("Scout is using the terminal");
  await screen.findByRole("button", { name: "Take over" });
  expect(screen.getByRole("tab", { name: "Terminal, in use" })).toBeTruthy();
});

test("Take over tells Spade the person has it alone, and Hand back shares the computer again", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=browser", browsing);
  await screen.findByText("Scout is using the browser");
  await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
  await screen.findByText("You have the browser");
  expect(spade.sent("POST", "/v1/agents/scout/computer/take-over")).toHaveLength(1);
  expect(spade.computer.driver("scout")).toBe("person");

  await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
  await screen.findByText("Scout is using the browser");
  expect(spade.sent("POST", "/v1/agents/scout/computer/hand-back")).toHaveLength(1);
  expect(spade.computer.driver("scout")).toBe("bot");
});

test("the person types in the bot's terminal without taking over, and sees the shell answer", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=terminal", (api) => {
    seed(api);
    api.computer.use("scout", { kind: "terminal", live: true, title: "fares.py" });
    api.computer.print("scout", "$ python fares.py\r\nCheapest: €212\r\n$ ");
  });
  const panel = await screen.findByRole("tabpanel", { name: "Terminal" });
  await waitFor(() =>
    expect(screen.getByRole("tabpanel", { name: "Terminal" }).textContent).toContain(
      "Cheapest: €212",
    ),
  );
  expect(panel.isConnected).toBe(true);
  const input = await within(panel).findByRole("textbox", { name: "Scout's input" });
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.keyDown(input, { key: "l" });
  fireEvent.keyDown(input, { key: "s" });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/scout/terminal/input").map(decoded).join("")).toBe(
      "ls\r",
    ),
  );
  // Spade's shell answered, and the view drew it.
  await waitFor(() => expect(panel.textContent).toContain("ran: ls"));
  expect(spade.computer.driver("scout")).toBe("bot");
});

test("after Take over the terminal waits for the bot's work to stop before taking keys", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=terminal", (api) => {
    seed(api);
    botAtWork(api, "scout");
    api.computer.use("scout", { kind: "terminal", live: true, title: "fares.py" });
    api.computer.stopping("scout", true);
  });
  const panel = await screen.findByRole("tabpanel", { name: "Terminal" });
  const input = await within(panel).findByRole("textbox", { name: "Scout's input" });
  await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
  await screen.findByText("Stopping Scout…");
  expect((input as HTMLTextAreaElement).disabled).toBe(true);

  spade.computer.stopping("scout", false);
  await screen.findByText("You have the terminal");
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
});

test("the file manager opens and saves a file, makes a folder, moves, uploads and deletes through Spade", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files", (api) => {
    seed(api);
    api.files.set("scout", { "plan.md": "# Plan\n", "old.txt": "x" });
  });
  // Shared: changes go with no take-over.
  const files = await screen.findByRole("list", { name: "Files" });
  await userEvent.click(await within(files).findByRole("button", { name: /^plan\.md/ }));
  const editor = await screen.findByRole("textbox", { name: "plan.md" });
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("# Plan\n"));
  await userEvent.type(editor, "Day 2");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/files?path=plan.md")).toEqual([
      { text: "# Plan\nDay 2", base: fakeFileRevision("# Plan\n") },
    ]),
  );
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nDay 2");

  await userEvent.click(screen.getByRole("button", { name: "Files" }));
  await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
  await userEvent.type(screen.getByRole("textbox", { name: "New folder name" }), "trips{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/scout/files/mkdir")).toEqual([{ path: "trips" }]),
  );
  await within(await screen.findByRole("list", { name: "Files" })).findByRole("button", {
    name: /^trips/,
  });

  await userEvent.click(screen.getByRole("button", { name: "More for old.txt" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename or move" }));
  const name = screen.getByRole("textbox", { name: "New name or path for old.txt" });
  await userEvent.clear(name);
  await userEvent.type(name, "trips/old.txt{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/scout/files/move")).toEqual([
      { from: "old.txt", to: "trips/old.txt", base: fakeFileRevision("x") },
    ]),
  );

  const upload = screen.getByLabelText("Files to upload");
  fireEvent.change(upload, { target: { files: [new File(["hello"], "notes.txt")] } });
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/scout/files/upload")).toEqual([
      { path: "notes.txt", data_b64: btoa("hello") },
    ]),
  );

  await userEvent.click(await screen.findByRole("button", { name: "More for notes.txt" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(
      spade.requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path ===
            `/v1/agents/scout/workspace?path=notes.txt&base=${fakeFileRevision("hello")}`,
      ),
    ).toBe(true),
  );
});

test("the profile holds the bot's routines and spending in Details, its notes and files in Library, and what it used in Computer", async () => {
  await spadeApp("/spade/scout", (api) => {
    seed(api);
    api.computer.use("scout", {
      kind: "terminal",
      live: false,
      title: "fares.py",
      last: Date.now() - 3 * 60_000,
    });
    api.routines.agentRoute("POST", "scout", "routines", {
      name: "Fare check",
      instruction: "Check fares.",
      trigger: { kind: "schedule", schedule: "daily at 18:00" },
    });
    api.notes.add({ text: "Home airport is OPO", agent: "scout", scope: "agent", source: "bot" });
    api.files.set("scout", { "fares.csv": "date,price\n" });
    const scout = api.agents.find((agent) => agent.id === "scout");
    if (scout) scout.spending = { today_micros: 180_000, month_micros: 1_240_000 };
  });
  await openProfile("Scout");
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  for (const section of ["Task", "Runs with", "Routines", "Apps", "Spending"])
    await profile.findByRole("heading", { name: section });
  const routines = profile.getByRole("heading", { name: "Routines" }).closest("section");
  await waitFor(() => expect(routines?.textContent).toContain("Fare check"));
  expect(profile.getByText("$1.24")).toBeTruthy();

  await userEvent.click(profile.getByRole("tab", { name: "Library" }));
  expect(await profile.findByText("Home airport is OPO")).toBeTruthy();
  await userEvent.click(await profile.findByRole("button", { name: /fares\.csv/ }));
  // A file opens in Computer's Files, beside what else it used.
  const tabs = await profile.findByRole("tablist", { name: "Computer" });
  expect(within(tabs).getByRole("tab", { name: "Deck" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(within(tabs).getByRole("tab", { name: "Terminal" })).toBeTruthy();
});

test("on a phone the profile takes the window, with Chat to go back", async () => {
  phoneWindow();
  await spadeApp("/spade", browsing);
  await userEvent.click(await botRow("Scout"));
  await userEvent.click(await screen.findByRole("button", { name: "Scout: open its profile" }));
  await screen.findByRole("region", { name: "Scout's profile" });
  // The chat is under it, out of reach.
  expect(screen.queryByRole("combobox", { name: "Message Scout" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
  await screen.findByRole("combobox", { name: "Message Scout" });
  expect(screen.queryByRole("region", { name: "Scout's profile" })).toBeNull();
});

test("handing back leaves one quiet line in the chat, with what changed behind a disclosure as plain text", async () => {
  const { spade } = await spadeApp("/spade/scout", seed);
  await screen.findByRole("feed", { name: "Conversation with Scout" });
  spade.store("c-scout", {
    type: "computer_handed_back",
    text: "They had it for about 3 minutes. They used your terminal.",
    data: ["new: notes/plan.md", "went to: https://example.com/account"],
  });
  const note = await within(screen.getByRole("feed")).findByRole("note");
  expect(note.textContent).toContain("They had it for about 3 minutes. They used your terminal.");
  const changed = within(note).getByText("What changed");
  // Closed at first, and the names are never links.
  expect(changed.closest("details")?.open).toBe(false);
  await userEvent.click(changed);
  expect(
    within(within(note).getByRole("list", { name: "What changed" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["new: notes/plan.md", "went to: https://example.com/account"]);
  expect(within(note).queryByRole("link")).toBeNull();
});

test("Take over gives the controls only once Spade itself says the bot's work has stopped", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=terminal", (api) => {
    seed(api);
    botAtWork(api, "scout");
    api.computer.use("scout", { kind: "terminal", live: true, title: "fares.py" });
    api.computer.stopping("scout", true);
  });
  const panel = await screen.findByRole("tabpanel", { name: "Terminal" });
  const input = await within(panel).findByRole("textbox", { name: "Scout's input" });
  // No frame follows the take-over: only Spade's answer to reading the computer counts.
  spade.computer.quiet = true;
  await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
  await waitFor(() =>
    expect(
      spade.requests.filter(
        (request) => request.method === "GET" && request.path === "/v1/agents/scout/computer",
      ),
    ).not.toHaveLength(0),
  );
  await screen.findByText("Stopping Scout…");
  expect((input as HTMLTextAreaElement).disabled).toBe(true);

  spade.computer.quiet = false;
  spade.computer.stopping("scout", false);
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
});

test("while a take-over is on its way, files can be read and downloaded but every change waits", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files", (api) => {
    seed(api);
    api.files.set("scout", { "plan.md": "# Plan\n" });
  });
  const writes = () =>
    spade.requests.filter(
      (request) =>
        request.path.includes("/files") ||
        (request.method === "DELETE" && request.path.includes("/workspace")),
    );
  const files = await screen.findByRole("list", { name: "Files" });
  await userEvent.click(within(files).getByRole("button", { name: /^plan\.md/ }));
  const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "plan.md" });
  await waitFor(() => expect(editor.value).toBe("# Plan\n"));
  // Shared: it can be changed now.
  expect(editor.readOnly).toBe(false);

  // Delete asks first; taken over meanwhile (the bot's work still stopping), the answer waits.
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  const confirm = within(await screen.findByRole("dialog", { name: "Delete plan.md?" }));
  spade.computer.stopping("scout", true);
  spade.answer({ method: "POST", path: "/v1/agents/scout/computer/take-over", body: undefined });
  await waitFor(() => expect(editor.readOnly).toBe(true));
  await userEvent.click(confirm.getByRole("button", { name: "Delete" }));
  expect(writes()).toEqual([]);
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\n");
  await screen.findByText("Stopping Scout…");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("the status says the bot waits for the person while their input makes it yield", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=browser", browsing);
  await screen.findByText("Scout is using the browser");
  spade.computer.personActive("scout", "browser", true);
  await screen.findByText("Scout is waiting for you");
  spade.computer.personActive("scout", "browser", false);
  await screen.findByText("Scout is using the browser");
});

test("words typed while a file saves stay as the draft", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", (api) => {
    seed(api);
    api.files.set("scout", { "plan.md": "# Plan\n" });
  });
  const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "plan.md" });
  await waitFor(() => expect(editor.value).toBe("# Plan\n"));
  fireEvent.change(editor, { target: { value: "# Plan\nDay 1" } });
  // Saved, then typed in before the answer came back.
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.change(editor, { target: { value: "# Plan\nDay 1\nDay 2" } });
  await waitFor(() => expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nDay 1"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull());
  expect(editor.value).toBe("# Plan\nDay 1\nDay 2");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
});

test("Take over in the profile says the person has it, with Hand back", async () => {
  const { spade } = await spadeApp("/spade/scout?profile=computer", browsing);
  const panel = within(await screen.findByRole("region", { name: "Scout's profile" }));
  await userEvent.click(await panel.findByRole("button", { name: "Take over" }));
  await panel.findByText("You have the browser");
  expect(panel.queryByRole("button", { name: "Take over" })).toBeNull();
  await userEvent.click(panel.getByRole("button", { name: "Hand back" }));
  await panel.findByRole("button", { name: "Take over" });
  expect(spade.computer.driver("scout")).toBe("bot");
});

test("while the person drives, the bot reads as paused, with no clock and no Stop", async () => {
  await spadeApp("/spade/scout", (api) => {
    browsing(api);
    const scout = api.agents.find((agent) => agent.id === "scout");
    if (!scout) throw new Error("no Scout");
    api.store(scout.conversation, { type: "user_message", text: "Find a hotel." });
    api.store(scout.conversation, { type: "reply_started", reply: "r1" });
    api.status(scout, "working", "Comparing hotels");
  });
  const feed = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  await feed.findByText("Comparing hotels");
  expect(screen.getByRole("button", { name: "Stop the agent" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Watch" }));
  const panel = within(await screen.findByRole("region", { name: "Scout's profile" }));
  await userEvent.click(await panel.findByRole("button", { name: "Take over" }));
  const line = await feed.findByRole("status");
  await waitFor(() => expect(line.textContent).toBe("Paused while you have the computer"));
  expect(feed.queryByText("Comparing hotels")).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  await waitFor(async () =>
    expect((await botRow("Scout")).textContent).toContain("Paused while you have the computer"),
  );
});

const reads = (spade: FakeSpadeApi) =>
  spade.requests.filter(
    (request) => request.method === "GET" && request.path === "/v1/agents/scout/computer",
  ).length;

test("a read of the computer that lands after the stream dropped gives no controls", async () => {
  const { app, spade } = await spadeApp("/spade/scout?computer=terminal", usingTerminal);
  const panel = await screen.findByRole("tabpanel", { name: "Terminal" });
  const input = await within(panel).findByRole<HTMLTextAreaElement>("textbox", {
    name: "Scout's input",
  });
  const release = spade.computer.holdReads();
  await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
  await waitFor(() => expect(reads(spade)).toBe(1));
  // The stream drops while the read is out, and can't come back while Spade is away.
  app.daemon.spade.status = { state: "starting" };
  app.daemon.spade.endStreams("/v1/conversations/c-scout/live");
  release();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Hand back" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect(input.disabled).toBe(true);
});

test("in cowork the person's keys stop once the stream drops, and come back with it", async () => {
  const { app } = await spadeApp("/spade/scout?computer=terminal", seed);
  const panel = await screen.findByRole("tabpanel", { name: "Terminal" });
  const input = await within(panel).findByRole<HTMLTextAreaElement>("textbox", {
    name: "Scout's input",
  });
  await waitFor(() => expect(input.disabled).toBe(false));
  // What the app last heard says cowork, but it can't be sure of it any more.
  app.daemon.spade.status = { state: "starting" };
  app.daemon.spade.endStreams("/v1/conversations/c-scout/live");
  await waitFor(() => expect(input.disabled).toBe(true));
  app.daemon.spade.status = { state: "ready", version: "0.6.0" };
  await waitFor(() => expect(input.disabled).toBe(false));
});

test("a slow read never overwrites a newer state from the stream", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=terminal", usingTerminal);
  const panel = await screen.findByRole("tabpanel", { name: "Terminal" });
  const input = await within(panel).findByRole<HTMLTextAreaElement>("textbox", {
    name: "Scout's input",
  });
  const release = spade.computer.holdReads();
  await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
  // Read while the bot had stopped; then, before it lands, Spade says the bot is stopping.
  await waitFor(() => expect(reads(spade)).toBe(1));
  spade.computer.stopping("scout", true);
  await screen.findByText("Stopping Scout…");
  release();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Hand back" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByText("Stopping Scout…")).toBeTruthy();
  expect(input.disabled).toBe(true);
});
