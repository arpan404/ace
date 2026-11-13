import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const staybook = "https://www.staybook.com/lisbon?max=180";

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return spade.addAgent({ id: "scout", name: "Scout" });
}

/** Scout at work in its browser. */
function browsing(spade: FakeSpadeApi) {
  seed(spade);
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

test("a live tile is pinned above the chat while the bot uses its browser, and goes when it stops", async () => {
  const { spade } = await spadeApp("/spade/scout", seed);
  await screen.findByRole("combobox", { name: "Message Scout" });
  expect(screen.queryByRole("region", { name: /live$/ })).toBeNull();

  spade.computer.use("scout", { kind: "browser", live: true, title: "Hotels", url: staybook });
  const tile = await screen.findByRole("region", { name: "Browser · staybook.com, live" });
  expect(within(tile).getByText("Hotels")).toBeTruthy();
  // The list says it too, on Scout's row.
  expect(
    within(await botRow("Scout")).getByRole("img", { name: "Using its browser" }),
  ).toBeTruthy();

  spade.computer.use("scout", { kind: "browser", live: false, title: null, url: staybook });
  await waitFor(() => expect(screen.queryByRole("region", { name: /live$/ })).toBeNull());
});

test("Hide puts the tile away until Watch on the working line brings it back", async () => {
  const { spade } = await spadeApp("/spade/scout", (api) => {
    const scout = seed(api);
    api.store(scout.conversation, { type: "user_message", text: "Find a hotel." });
    api.store(scout.conversation, { type: "reply_started", reply: "r1" });
    api.status(scout, "working", "Comparing hotels");
    api.computer.use("scout", { kind: "browser", live: true, title: "Hotels", url: staybook });
  });
  const tile = await screen.findByRole("region", { name: /live$/ });
  await userEvent.click(within(tile).getByRole("button", { name: "Hide" }));
  expect(screen.queryByRole("region", { name: /live$/ })).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Watch" }));
  await screen.findByRole("region", { name: /live$/ });
  expect(spade.requests.some((request) => request.path.includes("take-over"))).toBe(false);
});

test("Expand gives the computer the main column with the chat docked beside it, Chat hides the dock, and collapsing goes back", async () => {
  await spadeApp("/spade/scout", browsing);
  const tile = await screen.findByRole("region", { name: /live$/ });
  await userEvent.click(within(tile).getByRole("button", { name: "Expand" }));

  const tabs = await screen.findByRole("tablist", { name: "Computer" });
  expect(
    within(tabs)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual([expect.stringMatching(/^Browser/), "Files"]);
  expect(
    within(tabs)
      .getByRole("tab", { name: /Browser/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByLabelText("Address").textContent).toContain("staybook.com");
  const dock = screen.getByRole("complementary", { name: "Chat with Scout" });
  expect(within(dock).getByRole("combobox", { name: "Message Scout" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(screen.queryByRole("complementary", { name: "Chat with Scout" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Chat" }));
  await screen.findByRole("complementary", { name: "Chat with Scout" });

  await userEvent.click(screen.getByRole("button", { name: "Back to the chat" }));
  await waitFor(() => expect(screen.queryByRole("tablist", { name: "Computer" })).toBeNull());
  await screen.findByRole("region", { name: /live$/ });
});

test("Take over tells Spade the person drives, and Hand back gives the computer back", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=browser", browsing);
  await screen.findByText("Scout is driving");
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  await screen.findByText(/Scout is paused\./);
  expect(spade.sent("POST", "/v1/agents/scout/computer/take-over")).toHaveLength(1);
  expect(spade.computer.driver("scout")).toBe("person");

  await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
  await screen.findByText("Scout is driving");
  expect(spade.sent("POST", "/v1/agents/scout/computer/hand-back")).toHaveLength(1);
  expect(spade.computer.driver("scout")).toBe("bot");
});

test("the bot's terminal shows its output to everyone and takes keys only while the person drives", async () => {
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
  expect((input as HTMLTextAreaElement).disabled).toBe(true);
  expect(spade.sent("POST", "/v1/agents/scout/terminal/input")).toHaveLength(0);

  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
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
});

test("after Take over the terminal waits for the bot's work to stop before taking keys", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=terminal", (api) => {
    seed(api);
    api.computer.stopping("scout", true);
  });
  const panel = await screen.findByRole("tabpanel", { name: "Terminal" });
  const input = await within(panel).findByRole("textbox", { name: "Scout's input" });
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  await screen.findByText("Stopping Scout…");
  expect((input as HTMLTextAreaElement).disabled).toBe(true);

  spade.computer.stopping("scout", false);
  await screen.findByText(/Scout is paused\./);
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
});

test("the file manager opens and saves a file, makes a folder, moves, uploads and deletes through Spade", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files", (api) => {
    seed(api);
    api.files.set("scout", { "plan.md": "# Plan\n", "old.txt": "x" });
  });
  // Changes need the person driving.
  await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
  await screen.findByRole("button", { name: "Hand back" });
  const files = await screen.findByRole("list", { name: "Files" });
  await userEvent.click(await within(files).findByRole("button", { name: /^plan\.md/ }));
  const editor = await screen.findByRole("textbox", { name: "plan.md" });
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("# Plan\n"));
  await userEvent.type(editor, "Day 2");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/files?path=plan.md")).toEqual([
      { text: "# Plan\nDay 2" },
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
      { from: "old.txt", to: "trips/old.txt" },
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
          request.path === "/v1/agents/scout/workspace?path=notes.txt",
      ),
    ).toBe(true),
  );
});

test("a request waits above the composer saying who it goes to and what, and Send lets it go", async () => {
  const { spade } = await spadeApp("/spade/scout", (api) => {
    const scout = seed(api);
    api.ask(scout, "k-mail", "send_email", {
      to: { name: "Marta Reyes" },
      body: "Hi Marta, Thursday works.",
    });
  });
  const request = await screen.findByRole("group", {
    name: "Scout wants to send an email to Marta Reyes",
  });
  expect(within(request).getByText("Hi Marta, Thursday works.")).toBeTruthy();
  // Nothing more about the wait in the chat itself.
  expect(within(screen.getByRole("feed")).queryByText("Waiting for you")).toBeNull();
  await userEvent.click(within(request).getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-scout/approvals/k-mail")).toEqual([
      { allowed: true, always: false },
    ]),
  );
});

test("the bot's name opens its own page with its computer, routines, memory, files, activity and spending", async () => {
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
    if (scout)
      scout.spending = {
        today_micros: 180_000,
        month_micros: 1_240_000,
        daily_cap_micros: 1_000_000,
        monthly_cap_micros: null,
        capped: null,
        resets_at: null,
      };
  });
  await userEvent.click(await screen.findByRole("link", { name: /^Scout on .*open its page$/ }));
  for (const section of ["Computer", "Routines", "Memory", "Files", "Activity", "Spending"])
    await screen.findByRole("heading", { name: section });
  const routines = screen.getByRole("heading", { name: "Routines" }).closest("section");
  await waitFor(() => expect(routines?.textContent).toContain("Fare check"));
  expect(await screen.findByText("Home airport is OPO")).toBeTruthy();
  expect(await screen.findByText("fares.csv")).toBeTruthy();
  expect(screen.getByText("$1.24")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Open Terminal" }));
  const tabs = await screen.findByRole("tablist", { name: "Computer" });
  expect(
    within(tabs)
      .getByRole("tab", { name: /Terminal/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

test("on a phone the list is its own screen, and the computer fills the screen with ‹ Chat back", async () => {
  phoneWindow();
  await spadeApp("/spade", browsing);
  await userEvent.click(await botRow("Scout"));
  const tile = await screen.findByRole("region", { name: /live$/ });
  await userEvent.click(within(tile).getByRole("button", { name: "Expand" }));
  await screen.findByRole("tablist", { name: "Computer" });
  // Full screen: no chat beside it.
  expect(screen.queryByRole("complementary", { name: "Chat with Scout" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Message Scout" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Chat" }));
  await screen.findByRole("combobox", { name: "Message Scout" });
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
    api.computer.stopping("scout", true);
  });
  const panel = await screen.findByRole("tabpanel", { name: "Terminal" });
  const input = await within(panel).findByRole("textbox", { name: "Scout's input" });
  // No frame follows the take-over: only Spade's answer to reading the computer counts.
  spade.computer.quiet = true;
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
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

test("the bot's files can be read and downloaded while it drives; every change waits for the person to take over", async () => {
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
  expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "New folder" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await userEvent.click(within(files).getByRole("button", { name: "More for plan.md" }));
  const remove = await screen.findByRole("menuitem", { name: /^Delete/ });
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  expect(remove.textContent).toContain("Take over to change files");
  await userEvent.keyboard("{Escape}");

  await userEvent.click(within(files).getByRole("button", { name: /^plan\.md/ }));
  const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "plan.md" });
  await waitFor(() => expect(editor.value).toBe("# Plan\n"));
  expect(editor.readOnly).toBe(true);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(
    false,
  );

  // Taken over, Delete asks first; handed back meanwhile, the answer changes nothing.
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  await waitFor(() => expect(editor.readOnly).toBe(false));
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  const confirm = within(await screen.findByRole("dialog", { name: "Delete plan.md?" }));
  spade.answer({ method: "POST", path: "/v1/agents/scout/computer/hand-back", body: undefined });
  await waitFor(() => expect(editor.readOnly).toBe(true));
  await userEvent.click(confirm.getByRole("button", { name: "Delete" }));
  expect(writes()).toEqual([]);
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\n");
});

test("words typed while a file saves stay as the draft", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", (api) => {
    seed(api);
    api.files.set("scout", { "plan.md": "# Plan\n" });
  });
  await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
  const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "plan.md" });
  await waitFor(() => expect(editor.readOnly).toBe(false));
  fireEvent.change(editor, { target: { value: "# Plan\nDay 1" } });
  // Saved, then typed in before the answer came back.
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.change(editor, { target: { value: "# Plan\nDay 1\nDay 2" } });
  await waitFor(() => expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nDay 1"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull());
  expect(editor.value).toBe("# Plan\nDay 1\nDay 2");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
});

test("Take over on the tile turns it into who drives, with Hand back", async () => {
  const { spade } = await spadeApp("/spade/scout", browsing);
  const tile = await screen.findByRole("region", { name: /live$/ });
  await userEvent.click(within(tile).getByRole("button", { name: "Take over" }));
  await within(tile).findByText(/You're driving\./);
  expect(within(tile).queryByRole("button", { name: "Take over" })).toBeNull();
  await userEvent.click(within(tile).getByRole("button", { name: "Hand back" }));
  await within(tile).findByRole("button", { name: "Take over" });
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

  const tile = await screen.findByRole("region", { name: /live$/ });
  await userEvent.click(within(tile).getByRole("button", { name: "Take over" }));
  const line = await feed.findByRole("status");
  await waitFor(() => expect(line.textContent).toBe("Paused while you have the computer"));
  expect(feed.queryByText("Comparing hotels")).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  await waitFor(async () =>
    expect((await botRow("Scout")).textContent).toContain("Paused while you have the computer"),
  );
});
