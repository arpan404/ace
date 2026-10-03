import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

/** The design's daemon: its threads, then the automations and recent runs it holds. */
async function open(path: string) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now(), "UTC"));
  await app.open(path);
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  const sidebar = within(await within(aside).findByRole("region", { name: "Schedules" }));
  await sidebar.findByText("Nightly dependency audit");
  return { app, sidebar };
}

/** Turn the daemon's automation service on, as Settings › Automations does. */
const enableAutomations = (app: ReturnType<typeof harness>) =>
  app.client.request({
    type: "settings.set",
    key: "automations.enabled",
    value: true,
    layer: { kind: "global" },
  });

const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 2, name });
const field = (name: string) => screen.getByRole("textbox", { name });
const main = () => within(screen.getByRole("main"));

async function choose(select: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("schedules and triggers read in plain words, and paused ones say so", async () => {
  const { sidebar } = await open("/automations");
  const schedules = sidebar;
  expect(schedules.getByText("Every day at 02:00 · ace")).toBeTruthy();
  expect(
    schedules.getByText("When a pull request opens or changes in arpan404/ace · ace"),
  ).toBeTruthy();
  expect(schedules.getByText("Every 6 hours · ace")).toBeTruthy();
  const changelog = schedules.getByRole("link", { name: /Changelog draft/ });
  expect(within(changelog).getByText("Fridays at 16:00 · ace")).toBeTruthy();
  expect(within(changelog).getByText("off")).toBeTruthy();
});

test("an automation shows its prompt, where it runs and its recent runs with outcomes", async () => {
  const { sidebar } = await open("/automations");
  await userEvent.click(sidebar.getByRole("link", { name: /Nightly dependency audit/ }));

  await heading("Nightly dependency audit");
  expect(main().getByText("Every day at 02:00 · ace")).toBeTruthy();
  expect(screen.getByText(/Audit dependencies in each project for advisories/)).toBeTruthy();
  expect(
    await screen.findByText("Claude Code · work · Sonnet 4.5, in a fresh worktree"),
  ).toBeTruthy();
  const runs = within(screen.getByRole("list", { name: "Recent runs" }));
  expect(runs.getByText("2 advisories · opened a thread in ace")).toBeTruthy();
  expect(runs.getByText("Failed: npm registry timeout, retried once")).toBeTruthy();
  expect(runs.getByRole("img", { name: "failed" })).toBeTruthy();
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

  expect(await within(audit).findByText("off")).toBeTruthy();
  expect(screen.getByText("Paused. Resume to schedule the next run.")).toBeTruthy();
  expect(await screen.findByText("Paused · Nightly dependency audit")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Resume" }));
  await waitFor(() => expect(within(audit).queryByText("off")).toBeNull());
  expect(screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("true");
});

test("Run now starts a run on the daemon and lists it as running", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await enableAutomations(app);

  await userEvent.click(screen.getAllByRole("button", { name: "Run now" })[0] ?? document.body);

  const runs = within(screen.getByRole("list", { name: "Recent runs" }));
  expect(await runs.findByText("Running…")).toBeTruthy();
  const toasts = within(screen.getByRole("region", { name: "Notifications" }));
  expect(await toasts.findByText("Started · Nightly dependency audit")).toBeTruthy();
});

test("Run now while automations are off says how to turn them on", async () => {
  await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");

  await userEvent.click(screen.getAllByRole("button", { name: "Run now" })[0] ?? document.body);

  const toasts = within(screen.getByRole("region", { name: "Notifications" }));
  expect(
    await toasts.findByText("Automations are turned off. Turn them on in Settings to run one."),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("list", { name: "Recent runs" })).queryByText("Running…"),
  ).toBeNull();
});

test("a new automation is validated, read back in words and opened once created", async () => {
  await open("/automations");
  await userEvent.click(screen.getByRole("link", { name: "New automation" }));
  await heading("New automation");

  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));
  expect(await screen.findByText("Give the automation a name.")).toBeTruthy();
  expect(screen.getByText("Say what the agent should do.")).toBeTruthy();

  await userEvent.type(field("Name"), "Morning triage");
  await userEvent.type(
    field("What should the agent do?"),
    "Summarise overnight CI failures and open a thread for each new one.",
  );
  await choose("Repeat", "Weekdays");
  await userEvent.clear(field("At"));
  await userEvent.type(field("At"), "8:30");
  expect(await screen.findByText("Use 24-hour time, like 09:30.")).toBeTruthy();
  await userEvent.clear(field("At"));
  await userEvent.type(field("At"), "08:30");
  expect(await screen.findByText("Weekdays at 08:30")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));

  await heading("Morning triage");
  expect(main().getByText("Weekdays at 08:30 · ace")).toBeTruthy();
  const aside = screen.getByRole("complementary", { name: "Automations" });
  expect(within(aside).getByRole("link", { name: /Morning triage/ })).toBeTruthy();
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
});

test("editing an automation's schedule changes how it reads everywhere", async () => {
  const { sidebar } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");

  await userEvent.click(screen.getByRole("link", { name: "Edit prompt" }));
  await heading("Edit automation");
  expect((field("Name") as HTMLInputElement).value).toBe("Flaky test triage");
  await choose("Repeat", "Once a week");
  await choose("Day", "Monday");
  await userEvent.clear(field("At"));
  await userEvent.type(field("At"), "06:00");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await heading("Flaky test triage");
  expect(main().getByText("Mondays at 06:00 · ace")).toBeTruthy();
  expect(sidebar.getByText("Mondays at 06:00 · ace")).toBeTruthy();
});

test("deleting an automation can be undone from the toast", async () => {
  const { sidebar } = await open("/automations/auto-changelog");
  await heading("Changelog draft");

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

  // Automations moves on to the first one left.
  await heading("Nightly dependency audit");
  await waitFor(() => expect(sidebar.queryByRole("link", { name: /Changelog draft/ })).toBeNull());
  const toasts = within(screen.getByRole("region", { name: "Notifications" }));
  await userEvent.click(await toasts.findByRole("button", { name: "Undo" }));
  expect(await sidebar.findByRole("link", { name: /Changelog draft/ })).toBeTruthy();
});

test("Automations opens on the first automation rather than an empty pane", async () => {
  await open("/automations");
  expect(await heading("Nightly dependency audit")).toBeTruthy();
  expect(screen.queryByText("No automation selected")).toBeNull();
});
