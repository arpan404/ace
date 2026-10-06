import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

type Seed = ReturnType<typeof workbenchServices>;

/** The design's daemon: its threads, then the automations and recent runs it holds. */
async function open(path: string, change?: (seed: Seed) => void) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const seed = workbenchServices(Date.now(), "UTC");
  change?.(seed);
  app.daemon.seedServices(seed);
  await app.open(path);
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  const sidebar = within(await within(aside).findByRole("list", { name: "Automations" }));
  await sidebar.findByText("Nightly dependency audit");
  return { app, sidebar };
}

/** The daemon's copy of one automation. */
async function stored(app: ReturnType<typeof harness>, id: string) {
  const reply = await app.client.request({ type: "automation.list" });
  return reply.automations?.find((automation) => automation.id === id);
}

/** Turn the daemon's automation service on or off, as Settings › General does. */
const setAutomations = (app: ReturnType<typeof harness>, value: boolean) =>
  app.client.request({
    type: "settings.set",
    key: "automations.enabled",
    value,
    layer: { kind: "global" },
  });

/** The detail page's Next run line. */
const next = () => screen.getByText("Next run").parentElement?.textContent ?? "";
const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 2, name });
const field = (name: string) => screen.getByRole("textbox", { name });
const main = () => within(screen.getByRole("main"));

async function choose(select: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("schedules and triggers read in plain words, and paused ones say so", async () => {
  const { sidebar } = await open("/automations");
  expect(sidebar.getByText("Every day at 02:00 · ace")).toBeTruthy();
  expect(
    sidebar.getByText("When a pull request opens or changes in arpan404/ace · ace"),
  ).toBeTruthy();
  expect(sidebar.getByText("Every 6 hours · ace")).toBeTruthy();
  const changelog = sidebar.getByRole("link", { name: /Changelog draft/ });
  expect(within(changelog).getByText("Fridays at 16:00 · ace")).toBeTruthy();
  expect(within(changelog).getByRole("img", { name: "Paused" })).toBeTruthy();
  expect(
    within(sidebar.getByRole("link", { name: /Nightly dependency audit/ })).queryByRole("img", {
      name: "Paused",
    }),
  ).toBeNull();
});

test("the sidebar list is one Tab stop that arrow keys move through", async () => {
  const { sidebar } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  const audit = sidebar.getByRole("link", { name: /Nightly dependency audit/ });
  audit.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement?.textContent).toMatch(/Review pull requests on open/);
  await userEvent.keyboard("{End}");
  expect(document.activeElement?.textContent).toMatch(/Changelog draft/);
});

test("an automation whose last run failed is marked in the list", async () => {
  const { sidebar } = await open("/automations", (seed) => {
    const latest = seed.runs?.find((run) => run.automationId === "auto-flaky-triage");
    if (latest) latest.status = "failed";
  });
  const flaky = sidebar.getByRole("link", { name: /Flaky test triage/ });
  expect(await within(flaky).findByRole("img", { name: "Last run failed" })).toBeTruthy();
});

test("an automation shows its prompt, where it runs and its recent runs with outcomes", async () => {
  const { sidebar } = await open("/automations");
  await userEvent.click(sidebar.getByRole("link", { name: /Nightly dependency audit/ }));

  await heading("Nightly dependency audit");
  expect(main().getByText(/^Every day at 02:00/)).toBeTruthy();
  expect(screen.getByText(/Audit dependencies in each project for advisories/)).toBeTruthy();
  expect(
    await screen.findByText("Claude Code · work · Sonnet 4.5, in a fresh worktree"),
  ).toBeTruthy();
  const runs = within(screen.getByRole("list", { name: "Recent runs" }));
  expect(runs.getByText("2 advisories · opened a thread in ace")).toBeTruthy();
  expect(runs.getByText("Failed: npm registry timeout, retried once")).toBeTruthy();
  expect(runs.getByRole("img", { name: "failed" })).toBeTruthy();
});

test("the next run is the daemon's schedule, or says automations are off on this machine", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await waitFor(() => expect(next()).toMatch(/Tonight|Today|Tomorrow|In \d+[mh]|Any moment/));

  await setAutomations(app, false);
  expect(await screen.findByText(/Automations are off on this machine/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Turn on Run automations" })).toBeTruthy();
  expect(next()).not.toContain("Calculated by the daemon");
});

test("a run reads when it started, how long it took and what started it", async () => {
  await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  const line = runs.getByText(/· 4 min · Scheduled$/);
  expect(line.getAttribute("title")).toMatch(/\d{4}/);
});

test("a recent run that left a thread opens it", async () => {
  await open("/automations/auto-pr-review");
  await heading("Review pull requests on open");
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  await userEvent.click(
    runs.getByRole("link", { name: "Open the thread for #212 · approved with 1 note" }),
  );
  expect(
    await screen.findByRole("heading", { level: 1, name: "Bump Codex app-server to 0.48" }),
  ).toBeTruthy();
});

test("a recent run without a thread opens what started it and what it found", async () => {
  await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  const flaky = within(await screen.findByRole("list", { name: "Recent runs" }));
  await userEvent.click(
    flaky.getByRole("button", { name: "Open the run Nothing flaky across 3 runs" }),
  );
  const details = await screen.findByRole("dialog", { name: "Flaky test triage" });
  expect(within(details).getByText("On its schedule")).toBeTruthy();
  expect(within(details).getByText("4 min")).toBeTruthy();
});

test("pausing stops the schedule and resuming from the menu restarts it", async () => {
  const { sidebar } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  const audit = sidebar.getByRole("link", { name: /Nightly dependency audit/ });
  expect(within(audit).queryByText("off")).toBeNull();

  await userEvent.click(screen.getByRole("switch", { name: "Enabled" }));

  expect(await within(audit).findByRole("img", { name: "Paused" })).toBeTruthy();
  expect(screen.getByText("Paused. Resume to schedule the next run.")).toBeTruthy();
  expect(await screen.findByText("Paused · Nightly dependency audit")).toBeTruthy();
  // A paused automation can't run: the header offers Resume instead of Run now.
  expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  expect(screen.getByRole("switch", { name: "Paused" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Resume" }));
  await waitFor(() => expect(within(audit).queryByRole("img", { name: "Paused" })).toBeNull());
  expect(screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
});

test("Resume in the header restarts a paused automation", async () => {
  await open("/automations/auto-changelog");
  await heading("Changelog draft");
  await userEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(await screen.findByText("Resumed · Changelog draft")).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Run now" })).toBeTruthy();
});

test("Run now starts a run on the daemon and lists it as running", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);

  await userEvent.click(screen.getByRole("button", { name: "Run now" }));

  const runs = within(screen.getByRole("list", { name: "Recent runs" }));
  expect(await runs.findByText("Running…")).toBeTruthy();
  const toasts = within(screen.getByRole("region", { name: "Notifications" }));
  expect(await toasts.findByText("Started · Nightly dependency audit")).toBeTruthy();
});

test("Run now is off, and says why, while automations are off on this machine", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, false);

  const run = await screen.findByRole("button", { name: "Run now" });
  expect(run.getAttribute("aria-disabled") ?? run.getAttribute("disabled")).not.toBeNull();
  expect(screen.getByRole("link", { name: "Turn on Run automations" })).toBeTruthy();

  await userEvent.click(screen.getByRole("link", { name: "Turn on Run automations" }));
  await userEvent.click(await screen.findByRole("switch", { name: "Run automations" }));
  await waitFor(() => expect(app.daemon.services.settings.get("automations.enabled")).toBe(true));
  await userEvent.click(screen.getByRole("link", { name: "Automations" }));
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  const list = within(await within(aside).findByRole("list", { name: "Automations" }));
  await userEvent.click(await list.findByRole("link", { name: /Nightly dependency audit/ }));
  await heading("Nightly dependency audit");
  await userEvent.click(await screen.findByRole("button", { name: "Run now" }));
  expect(
    await within(screen.getByRole("list", { name: "Recent runs" })).findByText("Running…"),
  ).toBeTruthy();
});

test("a refused Run now is told as an error", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  app.daemon.failRequests("automation.run");
  await userEvent.click(screen.getByRole("button", { name: "Run now" }));
  // An error, announced at once, not a confirmation.
  expect(await screen.findByRole("alert")).toBeTruthy();
  app.daemon.restoreRequests();
});

test("a new automation is validated, read back in words and opened once created", async () => {
  await open("/automations");
  await userEvent.click(screen.getByRole("link", { name: "New automation" }));
  await heading("New automation");

  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));
  expect(await screen.findByText("Give the automation a name.")).toBeTruthy();
  expect(screen.getByText("Say what the agent should do.")).toBeTruthy();
  // The failed save moves to the first field to fix, which carries its error.
  const name = field("Name");
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(name.getAttribute("aria-describedby")).toBeTruthy();
  expect(document.getElementById(name.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Give the automation a name.",
  );

  await userEvent.type(name, "Morning triage");
  expect(name.getAttribute("aria-invalid")).toBeNull();
  await userEvent.type(
    field("What should the agent do?"),
    "Summarise overnight CI failures and open a thread for each new one.",
  );
  await choose("Repeat", "Weekdays");
  await userEvent.clear(screen.getByLabelText("At"));
  await userEvent.type(screen.getByLabelText("At"), "08:30");
  await userEvent.clear(screen.getByRole("combobox", { name: "Time zone" }));
  await userEvent.type(screen.getByRole("combobox", { name: "Time zone" }), "Europe/London");
  const readBack = await screen.findByText(/^Runs:/);
  expect(readBack.textContent).toMatch(
    /Weekdays at 08:30 \(Europe\/London\)\. Next: \w{3} \d+ \w{3} 08:30/,
  );

  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));

  await heading("Morning triage");
  expect(main().getByText("Weekdays at 08:30 (Europe/London)")).toBeTruthy();
  const aside = screen.getByRole("complementary", { name: "Automations" });
  expect(within(aside).getByRole("link", { name: /Morning triage/ })).toBeTruthy();
});

test("every few hours is picked from a list, so it can't be anything but a whole number", async () => {
  await open("/automations/new");
  await heading("New automation");
  await choose("Repeat", "Every few hours");
  await choose("How often", "Every 12 hours");
  expect((await screen.findByText(/^Runs:/)).textContent).toMatch(/Every 12 hours/);
  expect(screen.queryByText(/NaN/)).toBeNull();
});

test("the model is picked from the agent's models, by name", async () => {
  await open("/automations/new");
  await heading("New automation");
  await userEvent.click(screen.getByRole("combobox", { name: "Model" }));
  const options = await screen.findAllByRole("option");
  expect(options[0]?.textContent).toBe("Agent's default");
  expect(options.some((option) => /Claude Code · .*Sonnet/.test(option.textContent ?? ""))).toBe(
    true,
  );
  expect(options.some((option) => /:/.test(option.textContent ?? ""))).toBe(false);
});

test("a custom cron schedule must have five fields and is described once it does", async () => {
  await open("/automations/new");
  await heading("New automation");
  await choose("Repeat", "Custom (RRULE or cron)");
  await userEvent.click(screen.getByRole("button", { name: "Cron" }));

  await userEvent.type(field("Expression"), "30 7 * *");
  await userEvent.tab();
  expect(
    await screen.findByText("Cron needs five fields: minute hour day month weekday."),
  ).toBeTruthy();

  await userEvent.type(field("Expression"), " 1-5");
  await waitFor(() =>
    expect(screen.queryByText("Cron needs five fields: minute hour day month weekday.")).toBeNull(),
  );
  expect(screen.getByText("Weekdays at 07:30")).toBeTruthy();
});

test("a GitHub trigger needs an owner/name repository", async () => {
  await open("/automations/new");
  await heading("New automation");
  await userEvent.click(screen.getByRole("button", { name: "On a GitHub event" }));

  await userEvent.type(field("Repository"), "ace");
  await userEvent.tab();
  expect(await screen.findByText("Use owner/name, like arpan404/ace.")).toBeTruthy();
  // "If a run was missed" only means something for a schedule.
  expect(screen.queryByRole("combobox", { name: "If a run was missed" })).toBeNull();
});

test("an issue-label trigger asks for its label and keeps it through an edit", async () => {
  const { app } = await open("/automations/auto-pr-review", (seed) => {
    for (const automation of seed.automations ?? [])
      if (automation.trigger.kind === "github")
        automation.trigger = {
          ...automation.trigger,
          event: "issue_labelled",
          label: "needs-triage",
        };
  });
  await heading("Review pull requests on open");
  expect(main().getByText(/When an issue is labelled \(needs-triage\)/)).toBeTruthy();
  await userEvent.click(screen.getByRole("link", { name: "Edit prompt" }));
  await heading("Edit automation");
  expect((field("Label") as HTMLInputElement).value).toBe("needs-triage");

  await userEvent.type(field("Name"), " (labelled)");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await heading("Review pull requests on open (labelled)");
  const saved = await stored(app, "auto-pr-review");
  expect(saved?.trigger).toMatchObject({ kind: "github", label: "needs-triage" });
});

test("an automation that watches files keeps its own trigger in the editor", async () => {
  await open("/automations/auto-flaky-triage", (seed) => {
    for (const automation of seed.automations ?? [])
      if (automation.id === "auto-flaky-triage")
        automation.trigger = { kind: "file", paths: ["src/**/*.test.ts"] };
  });
  await heading("Flaky test triage");
  await userEvent.click(screen.getByRole("link", { name: "Edit prompt" }));
  await heading("Edit automation");
  expect(screen.getByRole("button", { name: "On file change" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect((field("Paths to watch, one per line") as HTMLTextAreaElement).value).toBe(
    "src/**/*.test.ts",
  );
  expect(screen.queryByText(/Runs only when you press Run now/)).toBeNull();
});

test("leaving the editor with unsaved changes asks first", async () => {
  const { sidebar } = await open("/automations/new");
  await heading("New automation");
  await userEvent.type(field("Name"), "Half-written");

  await userEvent.click(sidebar.getByRole("link", { name: /Flaky test triage/ }));
  const ask = await screen.findByRole("dialog", { name: "Discard changes to this automation?" });
  await waitFor(() =>
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Keep editing" })),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect((field("Name") as HTMLInputElement).value).toBe("Half-written");

  await userEvent.click(sidebar.getByRole("link", { name: /Flaky test triage/ }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard" }),
  );
  await heading("Flaky test triage");
});

test("saving an edit isn't possible until something changed, and says it saved", async () => {
  await open("/automations/auto-flaky-triage/edit");
  await heading("Edit automation");
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save.hasAttribute("disabled") || save.getAttribute("aria-disabled") === "true").toBe(true);
  await userEvent.type(field("Name"), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await heading("Flaky test triage!");
  const toasts = within(screen.getByRole("region", { name: "Notifications" }));
  expect(await toasts.findByText("Saved · Flaky test triage!")).toBeTruthy();
});

test("editing an automation's schedule changes how it reads everywhere", async () => {
  const { sidebar } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");

  await userEvent.click(screen.getByRole("link", { name: "Edit prompt" }));
  await heading("Edit automation");
  expect((field("Name") as HTMLInputElement).value).toBe("Flaky test triage");
  await choose("Repeat", "Once a week");
  await choose("Day", "Monday");
  await userEvent.clear(screen.getByLabelText("At"));
  await userEvent.type(screen.getByLabelText("At"), "06:00");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await heading("Flaky test triage");
  expect(main().getByText(/^Mondays at 06:00/)).toBeTruthy();
  expect(sidebar.getByText("Mondays at 06:00 · ace")).toBeTruthy();
});

test("deleting an automation hides it at once, and Undo brings it back untouched", async () => {
  const { app, sidebar } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

  // Automations moves on to the next one in the list.
  await heading("Changelog draft");
  await waitFor(() =>
    expect(sidebar.queryByRole("link", { name: /Flaky test triage/ })).toBeNull(),
  );
  // Still on the daemon while Undo is offered.
  expect(await stored(app, "auto-flaky-triage")).toBeTruthy();
  const toasts = within(screen.getByRole("region", { name: "Notifications" }));
  await userEvent.click(await toasts.findByRole("button", { name: "Undo" }));
  expect(await sidebar.findByRole("link", { name: /Flaky test triage/ })).toBeTruthy();
  expect(await stored(app, "auto-flaky-triage")).toBeTruthy();
});

test("a deletion that isn't undone is sent once its toast closes", async () => {
  const { app, sidebar } = await open("/automations/auto-changelog");
  await heading("Changelog draft");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const toasts = within(screen.getByRole("region", { name: "Notifications" }));
  await userEvent.hover(await toasts.findByText("Deleted · Changelog draft"));
  await userEvent.click(await toasts.findByRole("button", { name: "Dismiss" }));
  await waitFor(async () => expect(await stored(app, "auto-changelog")).toBeUndefined());
  expect(sidebar.queryByRole("link", { name: /Changelog draft/ })).toBeNull();
});

test("Automations opens on the first automation rather than an empty pane", async () => {
  await open("/automations");
  expect(await heading("Nightly dependency audit")).toBeTruthy();
  expect(screen.queryByText("No automation selected")).toBeNull();
});

test("when the daemon can't list automations, the view says so once, in words, with a retry", async () => {
  const app = harness();
  app.daemon.failRequests("automation.list");
  await app.open("/automations");
  const aside = within(await screen.findByRole("complementary", { name: "Automations" }));
  expect(await main().findByText("Automations unavailable", {}, { timeout: 4000 })).toBeTruthy();
  expect(main().getByText("The daemon didn't answer. This loads again once it does.")).toBeTruthy();
  // The sidebar doesn't tell the same failure again in other words.
  expect(aside.getByText("Couldn't load the list.")).toBeTruthy();
  expect(aside.queryByText("Automations unavailable")).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(main().getByRole("button", { name: "Try again" }));
  expect(await aside.findByText("No automations yet")).toBeTruthy();
  // The main pane alone has the illustrated state and the way to make one.
  expect(await main().findByRole("link", { name: "New automation" })).toBeTruthy();
  expect(main().getAllByText("No automations yet")).toHaveLength(1);
});

test("while the list loads, the main pane doesn't claim nothing is selected", async () => {
  const app = harness();
  app.daemon.holdRequests("automation.list");
  await app.open("/automations");
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  expect(await within(aside).findByRole("status", { name: "Loading automations" })).toBeTruthy();
  expect(screen.queryByText("No automation selected")).toBeNull();
});

test("while a save is on its way the form is locked and leaving still asks", async () => {
  const { app, sidebar } = await open("/automations/new");
  await heading("New automation");
  await userEvent.type(field("Name"), "Slow save");
  await userEvent.type(field("What should the agent do?"), "Summarise the night's CI.");
  app.daemon.holdRequests("automation.put");
  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));

  // Nothing typed now could be left out of the save.
  await waitFor(() => expect(field("Name").matches(":disabled")).toBe(true));
  await userEvent.click(sidebar.getByRole("link", { name: /Flaky test triage/ }));
  expect(
    await screen.findByRole("dialog", { name: "Discard changes to this automation?" }),
  ).toBeTruthy();
});

/** Whether closing the window now would be stopped to ask. */
function leave() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test("closing the window with unsaved changes asks the browser to confirm", async () => {
  await open("/automations/new");
  await heading("New automation");
  expect(leave()).toBe(false);
  await userEvent.type(field("Name"), "Half-written");
  expect(leave()).toBe(true);
});

test("on a phone, Automations opens on its list rather than the first automation", async () => {
  const original = globalThis.matchMedia;
  // A 390px window: every min-width query fails, every max-width one holds.
  globalThis.matchMedia = (query: string) =>
    ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) satisfies MediaQueryList;
  try {
    await open("/automations");
    expect(
      within(screen.getByRole("main")).getByRole("link", { name: /Nightly dependency audit/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 2, name: "Nightly dependency audit" }),
    ).toBeNull();
  } finally {
    globalThis.matchMedia = original;
  }
});
