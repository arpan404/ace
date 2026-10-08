import {
  ThreadId,
  WorkspaceId,
  ItemId,
  type SearchResults,
  type SearchStatus,
} from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

type Harness = ReturnType<typeof harness>;

const results = () => screen.findByRole("listbox", { name: "Results" });
const field = () => screen.getByRole<HTMLInputElement>("combobox", { name: "Search every thread" });

/** Open the app, then the search dialog from the sidebar's Search, and type `query`. */
async function search(query = "", app: Harness = harness()) {
  const view = await app.open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "App" })).getByRole("button", { name: "Search" }),
  );
  await screen.findByRole("dialog", { name: "Search" });
  if (query) await userEvent.type(field(), query);
  return view;
}

afterEach(() => localStorage.clear());

test("every word must match, and matches are highlighted in the snippet", async () => {
  await search("retry budget");

  const options = within(await results()).getAllByRole("option");
  expect(options).toHaveLength(2);
  for (const option of options)
    expect(option.textContent).toContain("Retry budget for app-server restarts");
  const marks = options.map((option) =>
    [...option.querySelectorAll("mark")].map((mark) => mark.textContent?.toLowerCase()),
  );
  expect(marks).toEqual([
    ["retry", "budget"],
    ["retry", "budget"],
  ]);
});

test("the kind filter keeps only commands", async () => {
  await search("dedupe");
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);

  await userEvent.type(field(), "{Control>}a{/Control}push");
  await userEvent.click(screen.getByRole("button", { name: "Commands" }));

  await waitFor(async () => {
    const options = within(await results()).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("git push --force-with-lease");
  });
});

test("arrow keys move through results and Enter opens the thread", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await search("the", app);
  const options = within(await results()).getAllByRole("option");
  expect(options[0]?.textContent).toContain("Dedupe thread events after reconnect");
  expect(options[0]?.getAttribute("aria-selected")).toBe("true");

  await userEvent.keyboard("{ArrowDown}");
  const second = within(await results()).getAllByRole("option")[1];
  expect(second?.getAttribute("aria-selected")).toBe("true");
  expect(second?.textContent).toContain("Retry budget for app-server restarts");
  await userEvent.keyboard("{Enter}");

  expect(
    await screen.findByRole("heading", { level: 1, name: "Retry budget for app-server restarts" }),
  ).toBeTruthy();
  // Opening a result puts the dialog away.
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
});

test("a search with no matches says so", async () => {
  await search("kubernetes");
  expect(await screen.findByText("No matches yet")).toBeTruthy();
});

test("emptying the field empties the results; Esc puts the dialog away, and it opens fresh", async () => {
  await search("replay");
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(2);
  expect(screen.getByText(/^\d+\+? results?$/)).toBeTruthy();
  await userEvent.clear(field());
  expect(screen.queryByRole("option")).toBeNull();

  await userEvent.type(field(), "replay");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
  await userEvent.keyboard("{Shift>}{Meta>}k{/Meta}{/Shift}");
  await screen.findByRole("dialog", { name: "Search" });
  expect(field().value).toBe("");
  expect(document.activeElement).toBe(field());
});

test("the palette hands its words to search", async () => {
  await harness().open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  await userEvent.type(within(palette).getByRole("combobox"), "retry budget");
  await userEvent.click(
    within(palette).getByRole("option", { name: "Search all threads for “retry budget”" }),
  );
  await screen.findByRole("dialog", { name: "Search" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  expect(field().value).toBe("retry budget");
  expect(within(await results()).getAllByRole("option")).toHaveLength(2);
});

test("Tab skips results and cycles through the search dialog's controls", async () => {
  await search("retry budget");
  await results();
  field().focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close search" }));
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "All" }));
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Project" }));
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Date" }));
  await userEvent.tab();
  await waitFor(() => expect(document.activeElement).toBe(field()));
});

test("a search that was opened is offered again from Recent, and can be forgotten", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const first = await search("retry budget", app);
  await within(await results()).findAllByRole("option");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Retry budget for app-server restarts" });
  first.unmount();

  await search();
  const recent = await screen.findByRole("region", { name: "Recent" });
  await userEvent.click(within(recent).getByRole("button", { name: "retry budget" }));
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);

  await userEvent.clear(field());
  await userEvent.click(
    within(await screen.findByRole("region", { name: "Recent" })).getByRole("button", {
      name: 'Forget "retry budget"',
    }),
  );
  expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
});

test("when search fails, the dialog says why and tries again", async () => {
  const app = harness();
  app.daemon.failRequests("search.query");
  await search("dedupe", app);
  expect(await screen.findByText("Search unavailable", {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.queryByText("unavailable")).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);
});

type SearchHit = SearchResults["hits"][number];
const hit = (kind: SearchHit["kind"], index: number): SearchHit => ({
  threadId: ThreadId.parse("thread-dedupe"),
  threadTitle: "Visible match",
  itemId: ItemId.parse(`match-${index}`),
  workspaceId: WorkspaceId.parse("ace"),
  provider: "claude",
  status: "done",
  statusSeq: 0,
  kind,
  createdAt: 10,
  title: { text: "Visible match", highlights: [] },
  snippet: {
    text: kind === "message" ? "The visible message" : "Hidden reasoning",
    highlights: [],
  },
  score: index,
});

test("All requests just the visible kinds so hidden items cannot fill the first page", async () => {
  const app = harness();
  const services = app.daemon.services;
  const handle = services.handle.bind(services);
  const corpus = [
    ...Array.from({ length: 60 }, (_, index) => hit("reasoning", index)),
    hit("message", 60),
  ];
  services.handle = (message, push) => {
    if (message.type !== "search.query") return handle(message, push);
    const visible = corpus.filter(
      (candidate) => !message.filters.kinds || message.filters.kinds.includes(candidate.kind),
    );
    push({
      type: "search.results",
      requestId: message.requestId,
      hits: visible.slice(0, message.limit),
      cursor: visible.length > message.limit ? "next" : null,
      generation: 1,
    });
    return true;
  };
  await search("visible", app);
  expect(within(await results()).getAllByRole("option")).toHaveLength(1);
  expect(screen.getByText("The visible message")).toBeTruthy();
});

test("an empty visible page keeps Show more until all pages have been checked", async () => {
  const app = harness();
  const services = app.daemon.services;
  const handle = services.handle.bind(services);
  services.handle = (message, push) => {
    if (message.type !== "search.query") return handle(message, push);
    push({
      type: "search.results",
      requestId: message.requestId,
      hits: message.cursor ? [hit("message", 1)] : [hit("reasoning", 0)],
      cursor: message.cursor ? null : "next",
      generation: 1,
    });
    return true;
  };
  await search("visible", app);
  expect(await screen.findByText("More results to check")).toBeTruthy();
  expect(screen.queryByText("No matches yet")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show more results" }));
  expect(await screen.findByText("The visible message")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show more results" })).toBeNull();
});

test("indexing progress softens an empty search and completion refreshes the results", async () => {
  const app = harness();
  const services = app.daemon.services;
  const handle = services.handle.bind(services);
  let progress: SearchStatus = {
    indexedSeq: 90,
    headSeq: 100,
    pending: 3,
    indexWrites: 0,
    generation: 1,
    ready: false,
  };
  services.handle = (message, push) => {
    if (message.type === "search.status") {
      push({ type: "search.progress", requestId: message.requestId, ...progress });
      return true;
    }
    if (message.type === "search.query") {
      push({
        type: "search.results",
        requestId: message.requestId,
        hits: progress.ready ? [hit("message", 1)] : [],
        cursor: null,
        generation: progress.generation,
      });
      return true;
    }
    return handle(message, push);
  };
  await search("visible", app);
  expect(await screen.findByText("Indexing… 13 left")).toBeTruthy();
  expect(await screen.findByText(/Some threads are still being indexed/)).toBeTruthy();
  progress = { ...progress, indexedSeq: 100, pending: 0, ready: true, generation: 2 };
  expect(await screen.findByText("The visible message", {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.queryByText(/Indexing…/)).toBeNull();
});

test("Project narrows matches and clearing it brings all projects back", async () => {
  const app = harness({ clock: () => Date.now() });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await search("the", app);
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(2);
  await userEvent.click(screen.getByRole("combobox", { name: "Project" }));
  await userEvent.click(await screen.findByRole("option", { name: "relay" }));
  await waitFor(() => {
    const options = within(screen.getByRole("listbox", { name: "Results" })).getAllByRole("option");
    expect(options).toHaveLength(4);
    expect(
      options.every((option) =>
        /Retry budget|Backpressure|Replay cursor/.test(option.textContent ?? ""),
      ),
    ).toBe(true);
  });
  await userEvent.click(screen.getByRole("combobox", { name: "Project" }));
  await userEvent.click(await screen.findByRole("option", { name: "All projects" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("listbox", { name: "Results" })).getAllByRole("option").length,
    ).toBeGreaterThan(2),
  );
});

test("Date narrows by creation time and Any time restores older matches", async () => {
  await search("replay", harness({ clock: () => Date.now() - 2 * 86_400_000 }));
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole("combobox", { name: "Date" }));
  await userEvent.click(await screen.findByRole("option", { name: "Past day" }));
  expect(await screen.findByText("No matches yet")).toBeTruthy();
  await userEvent.click(screen.getByRole("combobox", { name: "Date" }));
  await userEvent.click(await screen.findByRole("option", { name: "Any time" }));
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);
});
