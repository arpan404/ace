import { openProfileView } from "@/test/navigation.ts";
import { workbench, workbenchServices } from "@ace/fake-daemon";
import { configure, fireEvent, act, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

await import("../settings/agents-page.tsx");

type Seed = ReturnType<typeof workbenchServices>;

/** The design's daemon: its threads, then the automations and recent runs it holds. */
async function open(path: string, change?: (seed: Seed) => void) {
  const app = harness({ clock: () => Date.now(), storage: localStorage });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const seed = workbenchServices(Date.now(), "UTC");
  change?.(seed);
  app.daemon.seedServices(seed);
  await app.open(path);
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  const sidebar = within(await within(aside).findByRole("list", { name: "Automations" }));
  await sidebar.findByText(
    seed.automations?.find((entry) => entry.id === "auto-dependency-audit")?.title ??
      "Nightly dependency audit",
  );
  return { app, sidebar };
}

/** The daemon's copy of one automation. */
async function stored(app: ReturnType<typeof harness>, id: string) {
  const reply = await app.client.request({ type: "automation.list" });
  return reply.automations?.find((automation) => automation.id === id);
}

/** Turn the daemon's automation service on or off, as Settings › Agents does. */
const setAutomations = (app: ReturnType<typeof harness>, value: boolean) =>
  app.client.request({
    type: "settings.set",
    key: "automations.enabled",
    value,
    layer: { kind: "global" },
  });

/** The detail page's Next run line. */
const next = () => screen.getByText("When", { exact: true }).parentElement?.textContent ?? "";
const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 2, name });
const field = (name: string) => screen.getByRole("textbox", { name });
const main = () => within(screen.getByRole("main"));

async function choose(select: string, option: string) {
  if (["Time zone", "Permissions", "If a run was missed"].includes(select)) {
    const advanced = main().getByText("Advanced", { exact: true });
    if (!advanced.closest("details")?.open) await userEvent.click(advanced);
  }
  await userEvent.click(screen.getByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("schedules and triggers read in plain words, and paused ones say so", async () => {
  const { sidebar } = await open("/automations");
  await userEvent.hover(sidebar.getByRole("link", { name: /Nightly dependency audit/ }));
  expect(await screen.findByRole("tooltip", { name: "Every day at 02:00 · ace" })).toBeTruthy();
  await userEvent.unhover(sidebar.getByRole("link", { name: /Nightly dependency audit/ }));
  const changelog = sidebar.getByRole("link", { name: /Changelog draft/ });
  expect(within(changelog).getByText("Paused")).toBeTruthy();
  expect(
    within(sidebar.getByRole("link", { name: /Nightly dependency audit/ })).queryByText("Paused"),
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
  expect(await within(flaky).findByRole("img", { name: "Needs attention" })).toBeTruthy();
});

test("an automation shows its prompt, where it runs and its recent runs with outcomes", async () => {
  const { sidebar } = await open("/automations");
  await userEvent.click(sidebar.getByRole("link", { name: /Nightly dependency audit/ }));

  await heading("Nightly dependency audit");
  expect(main().getByText(/^Every day at 02:00/)).toBeTruthy();
  expect(screen.getByText(/Audit dependencies in each project for advisories/)).toBeTruthy();
  expect(
    await screen.findByText("Claude Code · Work · Sonnet 4.5, in a fresh worktree"),
  ).toBeTruthy();
  const runs = within(screen.getByRole("list", { name: "Recent runs" }));
  expect(runs.getByText("2 advisories · opened a thread in ace")).toBeTruthy();
  expect(runs.getByText("npm registry timeout, retried once")).toBeTruthy();
  expect(runs.getByText("Failed")).toBeTruthy();
});

test("the next run is the daemon's schedule, or says automations are off on this machine", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await waitFor(() => expect(next()).toMatch(/Tonight|Today|Tomorrow|In \d+[mh]|Any moment/));

  await setAutomations(app, false);
  expect(await screen.findByText(/Automations are off on this machine/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Turn on Run automations" })).toBeTruthy();
  expect(next()).not.toContain("Calculated by ace");
});

test("a run reads when it started, how long it took and what started it", async () => {
  await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  await userEvent.click(
    runs.getByRole("button", { name: "Open the run Nothing flaky across 3 runs" }),
  );
  expect(screen.getByText("Scheduled · 4 min")).toBeTruthy();
});

test("a recent run shows its output and opens the thread it produced", async () => {
  await open("/automations/auto-pr-review");
  await heading("Review pull requests on open");
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  await userEvent.click(
    runs.getByRole("button", { name: "Open the run #212 · approved with 1 note" }),
  );
  expect(screen.getAllByText("#212 · approved with 1 note")).toHaveLength(1);
  await userEvent.click(screen.getByRole("link", { name: "Open thread" }));
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
  const details = await screen.findByRole("region", { name: "Run details for Flaky test triage" });
  expect(within(details).getByText("Scheduled · 4 min")).toBeTruthy();
  expect(within(details).getByRole("region", { name: "Run output" }).textContent).toContain(
    "Nothing flaky across 3 runs",
  );
});

test("pausing stops the schedule and resuming from the switch restarts it", async () => {
  const { app, sidebar } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  const audit = sidebar.getByRole("link", { name: /Nightly dependency audit/ });
  expect(within(audit).queryByText("off")).toBeNull();

  await userEvent.click(screen.getByRole("switch", { name: "Enabled" }));

  expect(await within(audit).findByText("Paused")).toBeTruthy();
  expect(screen.getByText(/Paused\. Resume to schedule the next run\./)).toBeTruthy();
  await waitFor(async () =>
    expect((await stored(app, "auto-dependency-audit"))?.enabled).toBe(false),
  );
  expect(screen.getByRole("button", { name: "Run now" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  expect(screen.getByRole("switch", { name: "Paused" })).toBeTruthy();

  await userEvent.click(screen.getByRole("switch", { name: "Paused" }));
  await waitFor(() => expect(within(audit).queryByText("Paused")).toBeNull());
  expect(screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
  expect((await stored(app, "auto-dependency-audit"))?.enabled).toBe(true);
});

test("the switch restarts an automation that was already paused", async () => {
  const { app } = await open("/automations/auto-changelog");
  await heading("Changelog draft");
  await userEvent.click(screen.getByRole("switch", { name: "Paused" }));
  await waitFor(async () => expect((await stored(app, "auto-changelog"))?.enabled).toBe(true));
  expect(screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("true");
  expect(await screen.findByRole("button", { name: "Run now" })).toBeTruthy();
});

test("Run now starts a run on the daemon and lists it as running", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);

  await userEvent.click(screen.getByRole("button", { name: "Run now" }));

  const runs = within(screen.getByRole("list", { name: "Recent runs" }));
  expect(await runs.findByText("Running…")).toBeTruthy();
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
  await userEvent.click(screen.getByRole("link", { name: "Back to app" }));
  await openProfileView("Automations");
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
  await choose("Time zone", "Europe/London");
  const readBack = await screen.findByText(/^Next run/);
  expect(readBack.textContent).toMatch(/Next run \w{3} \d+ \w{3} 08:30/);

  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));

  await heading("Morning triage");
  expect(next()).toContain("Weekdays at 08:30 (Europe/London)");
  const aside = screen.getByRole("complementary", { name: "Automations" });
  expect(within(aside).getByRole("link", { name: /Morning triage/ })).toBeTruthy();
});

test("every few hours is picked from a list, so it can't be anything but a whole number", async () => {
  await open("/automations/new");
  await heading("New automation");
  await choose("Repeat", "Every few hours");
  await choose("How often", "Every 12 hours");
  expect(await screen.findByText(/^Next run/)).toBeTruthy();
  expect(screen.queryByText(/NaN/)).toBeNull();
});

test("the model is picked by name from the agent's models, its default chosen and older ones apart", async () => {
  await open("/automations/new");
  await heading("New automation");
  // Left alone it follows the agent's default, named rather than a stand-in "default".
  const model = await screen.findByRole("button", { name: /^Model: / });
  await waitFor(() => expect(model.getAttribute("aria-label")).toBe("Model: Opus 5.5, Default"));
  await userEvent.click(model);
  const list = await screen.findByRole("listbox", { name: "Models" });
  expect(
    within(list)
      .getAllByRole("option")
      .map((option) => option.getAttribute("aria-label")),
  ).toEqual([
    // Each row names its source: the provider and the account (706f991cb).
    "Opus 5.5, recommended, Claude Code · Personal",
    "Sonnet 5.5, Claude Code · Personal",
    "Haiku 4.5, Claude Code · Personal",
    "Legacy models, 6",
  ]);
  expect(list.textContent).not.toMatch(/claude-|Agent's default/);
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
  expect(await screen.findByText(/^Next run.*07:30/)).toBeTruthy();
});

test("a GitHub trigger needs an owner/name repository", async () => {
  await open("/automations/new");
  await heading("New automation");
  await choose("When it runs", "On a GitHub event");

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
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
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
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await heading("Edit automation");
  expect(screen.getByRole("combobox", { name: "When it runs" }).textContent).toContain(
    "On file change",
  );
  expect((field("File globs, one per line") as HTMLTextAreaElement).value).toBe("src/**/*.test.ts");
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

test("saving an edit isn't possible until something changed, then shows the saved automation", async () => {
  await open("/automations/auto-flaky-triage/edit");
  await heading("Edit automation");
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save.hasAttribute("disabled") || save.getAttribute("aria-disabled") === "true").toBe(true);
  await userEvent.type(field("Name"), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await heading("Flaky test triage!");
});

test("editing an automation's schedule changes how it reads everywhere", async () => {
  const { sidebar } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await heading("Edit automation");
  expect((field("Name") as HTMLInputElement).value).toBe("Flaky test triage");
  await choose("Repeat", "Once a week");
  await choose("Day", "Monday");
  await userEvent.clear(screen.getByLabelText("At"));
  await userEvent.type(screen.getByLabelText("At"), "06:00");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await heading("Flaky test triage");
  expect(main().getByText(/^Mondays at 06:00/)).toBeTruthy();
  await userEvent.hover(sidebar.getByRole("link", { name: /Flaky test triage/ }));
  expect(await screen.findByRole("tooltip", { name: "Mondays at 06:00 · ace" })).toBeTruthy();
});

test("deleting an automation removes it at once, and Undo recreates it with history intact", async () => {
  const { app, sidebar } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

  await heading("Changelog draft");
  await waitFor(() =>
    expect(sidebar.queryByRole("link", { name: /Flaky test triage/ })).toBeNull(),
  );
  expect(await stored(app, "auto-flaky-triage")).toBeUndefined();
  await screen.findByText("Deleted · Flaky test triage");
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await sidebar.findByRole("link", { name: /Flaky test triage/ })).toBeTruthy();
  expect(await stored(app, "auto-flaky-triage")).toBeTruthy();
  await userEvent.click(await sidebar.findByRole("link", { name: /Flaky test triage/ }));
  await heading("Flaky test triage");
  expect(
    within(await screen.findByRole("list", { name: "Recent runs" })).getByText(
      "Nothing flaky across 3 runs",
    ),
  ).toBeTruthy();
});

test("a rejected delete keeps the row and never shows Deleted", async () => {
  const { app, sidebar } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  const automation = await stored(app, "auto-flaky-triage");
  if (!automation) throw new Error("Missing automation");
  await app.client.request({
    type: "automation.put",
    automation: { ...automation, title: `${automation.title} elsewhere` },
  });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  expect(
    within(await screen.findByRole("alertdialog")).getByText(/changed elsewhere.*before deleting/i),
  ).toBeTruthy();
  expect(await sidebar.findByRole("link", { name: /Flaky test triage/ })).toBeTruthy();
  expect(screen.queryByText(/Deleted · Flaky test triage/)).toBeNull();
  expect(await stored(app, "auto-flaky-triage")).toBeTruthy();
});

test("a committed delete offers Undo while the list refresh is unavailable", async () => {
  const { app } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  app.daemon.holdRequests("automation.list");
  try {
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText("Deleted · Flaky test triage")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  } finally {
    app.daemon.restoreRequests();
  }
  expect(await stored(app, "auto-flaky-triage")).toBeUndefined();
});

test("offline pause cannot claim that an enabled automation stopped", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  act(() => app.daemon.refuseConnections(true));
  const enabled = screen.getByRole("switch", { name: "Enabled" });
  await waitFor(() =>
    expect(
      enabled.getAttribute("aria-disabled") === "true" || enabled.hasAttribute("disabled"),
    ).toBe(true),
  );
  await userEvent.click(enabled);
  expect(enabled.getAttribute("aria-checked")).toBe("true");
  act(() => app.daemon.refuseConnections(false));
  await waitFor(() =>
    expect(
      enabled.getAttribute("aria-disabled") === "true" || enabled.hasAttribute("disabled"),
    ).toBe(false),
  );
  expect((await stored(app, "auto-dependency-audit"))?.enabled).toBe(true);
});

test("a stale editor reports the conflict instead of overwriting", async () => {
  const { app } = await open("/automations/auto-flaky-triage/edit");
  await heading("Edit automation");
  const automation = await stored(app, "auto-flaky-triage");
  if (!automation) throw new Error("Missing automation");
  await app.client.request({
    type: "automation.put",
    automation: { ...automation, prompt: `${automation.prompt} Elsewhere.` },
  });
  await userEvent.type(field("Name"), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText(/changed elsewhere.*Reload/i)).toBeTruthy();
  expect((await stored(app, "auto-flaky-triage"))?.prompt).toContain("Elsewhere.");
});

test("an uncertain run keeps its key, and Retry reuses it without duplicating", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  app.daemon.failRequests("automation.run");
  await userEvent.click(screen.getByRole("button", { name: "Run now" }));
  expect(await screen.findByRole("button", { name: "Retry run" })).toBeTruthy();
  const kept = JSON.parse(localStorage.getItem("ace.automation.runIntents") ?? "[]");
  expect(kept).toHaveLength(1);
  const requestId = kept[0].requestId as string;
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Retry run" }));
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  expect(await runs.findByText("Running…")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("ace.automation.runIntents") ?? "[]")).toHaveLength(0);
  const inbox = await app.client.request({ type: "automation.inbox", limit: 50 });
  expect(inbox.inbox?.runs.filter((run) => run.id === `run-${requestId}`)).toHaveLength(1);
});

test("a lost acknowledgement still retries to the same admitted run after reopen", async () => {
  const { app, sidebar } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  app.daemon.failRequests("automation.run");
  await userEvent.click(screen.getByRole("button", { name: "Run now" }));
  expect(await screen.findByRole("button", { name: "Retry run" })).toBeTruthy();
  const kept = JSON.parse(localStorage.getItem("ace.automation.runIntents") ?? "[]");
  const requestId = kept[0].requestId as string;
  app.daemon.restoreRequests();
  await app.client.request(
    { type: "automation.run", id: "auto-dependency-audit", variables: {} },
    { requestId },
  );
  await userEvent.click(sidebar.getByRole("link", { name: /Review pull requests/ }));
  await heading("Review pull requests on open");
  await userEvent.click(sidebar.getByRole("link", { name: /Nightly dependency audit/ }));
  await heading("Nightly dependency audit");
  expect(await screen.findByRole("button", { name: "Retry run" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retry run" }));
  const inbox = await app.client.request({ type: "automation.inbox", limit: 100 });
  expect(inbox.inbox?.runs.filter((run) => run.id === `run-${requestId}`)).toHaveLength(1);
});

test("Run now refuses dispatch when the browser can only remember its retry key in memory", async () => {
  const app = harness({ storage: { ...memoryKeyValue(), durable: false } });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now(), "UTC"));
  await app.open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  const before = await app.client.request({ type: "automation.inbox", limit: 100 });
  await userEvent.click(screen.getByRole("button", { name: "Run now" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't save the run request");
  const after = await app.client.request({ type: "automation.inbox", limit: 100 });
  expect(after.inbox?.runs.map((run) => run.id)).toEqual(before.inbox?.runs.map((run) => run.id));
});

test("double-clicking Run now dispatches once", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  const before = await app.client.request({ type: "automation.inbox", limit: 100 });
  const beforeIds = new Set(
    (before.inbox?.runs ?? [])
      .filter(
        (candidate) =>
          candidate.automationId === "auto-dependency-audit" && candidate.trigger === "manual",
      )
      .map((candidate) => candidate.id),
  );
  app.daemon.holdRequests("automation.run");
  const run = screen.getByRole("button", { name: "Run now" });
  fireEvent.click(run);
  fireEvent.click(run);
  app.daemon.restoreRequests();
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  expect(await runs.findByText("Running…")).toBeTruthy();
  const inbox = await app.client.request({ type: "automation.inbox", limit: 100 });
  const fresh = (inbox.inbox?.runs ?? []).filter(
    (candidate) =>
      candidate.automationId === "auto-dependency-audit" &&
      candidate.trigger === "manual" &&
      !beforeIds.has(candidate.id),
  );
  expect(fresh).toHaveLength(1);
});

test("a valid custom RRULE is created and reads back", async () => {
  await open("/automations/new");
  await heading("New automation");
  await userEvent.type(field("Name"), "Monday sweep");
  await userEvent.type(field("What should the agent do?"), "Summarise the week.");
  await choose("Repeat", "Custom (RRULE or cron)");
  await userEvent.clear(field("Expression"));
  await userEvent.type(field("Expression"), "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=30");
  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));
  await heading("Monday sweep");
  expect(main().getByText(/^Mondays at 08:30/)).toBeTruthy();
});

test("an invalid custom RRULE fails in the form instead of reading no upcoming run", async () => {
  await open("/automations/new");
  await heading("New automation");
  await userEvent.type(field("Name"), "Bogus");
  await userEvent.type(field("What should the agent do?"), "Nothing.");
  await choose("Repeat", "Custom (RRULE or cron)");
  await userEvent.clear(field("Expression"));
  await userEvent.type(field("Expression"), "FREQ=BOGUS");
  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));
  expect(await screen.findByText(/valid RRULE/i)).toBeTruthy();
  expect(screen.queryByText("No upcoming run")).toBeNull();
});

test("a busy inbox still marks the failed automation from its own last run", async () => {
  const { sidebar } = await open("/automations/auto-flaky-triage", (seed) => {
    const failed = seed.runs?.find((run) => run.automationId === "auto-flaky-triage");
    if (failed) failed.status = "failed";
    const base = Date.now() + 60_000;
    const extra = Array.from({ length: 60 }, (_, index) => ({
      id: `busy-${index}`,
      automationId: "auto-dependency-audit",
      title: "Nightly dependency audit",
      eventKey: `busy-${index}`,
      trigger: "manual" as const,
      status: "succeeded" as const,
      startedAt: base + index,
      finishedAt: base + index + 1,
      result: `Busy ${index}`,
    }));
    seed.runs = [...(seed.runs ?? []), ...extra];
  });
  const flaky = sidebar.getByRole("link", { name: /Flaky test triage/ });
  expect(await within(flaky).findByRole("img", { name: "Needs attention" })).toBeTruthy();
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
  expect(main().getByText("ace didn't answer. This loads again once it does.")).toBeTruthy();
  // The sidebar doesn't tell the same failure again in other words.
  expect(aside.getByText("Couldn't load the list.")).toBeTruthy();
  expect(aside.queryByText("Automations unavailable")).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(main().getByRole("button", { name: "Try again" }));
  expect(await main().findByText("No automations yet")).toBeTruthy();
  expect(aside.queryByText("No automations yet")).toBeNull();
  // The main pane alone has the empty state and the way to make one.
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

test("an explicit automation model is saved as the provider model and survives editing", async () => {
  const { app } = await open("/automations/new");
  await heading("New automation");
  await userEvent.type(field("Name"), "Explicit model QA");
  await userEvent.type(field("What should the agent do?"), "Reply QA_AUTOMATION_OK");
  await choose("Agent", "Codex");
  await userEvent.click(await screen.findByRole("button", { name: /^Model: / }));
  await userEvent.click(await screen.findByRole("option", { name: /^GPT-5 Codex, / }));
  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));
  await heading("Explicit model QA");
  const reply = await app.client.request({ type: "automation.list" });
  const saved = reply.automations?.find((automation) => automation.title === "Explicit model QA");
  expect(saved?.model).toBe("gpt-5-codex");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await heading("Edit automation");
  expect((await screen.findByRole("button", { name: /^Model: / })).textContent).toContain(
    "GPT-5 Codex",
  );
}, 20_000);

test("saving an old automation repairs its catalog row model identity", async () => {
  const { app } = await open("/automations/auto-pr-review/edit");
  await heading("Edit automation");
  await userEvent.type(field("Name"), " repaired");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await heading("Review pull requests on open repaired");
  expect((await stored(app, "auto-pr-review"))?.model).toBe("gpt-5-codex");
}, 20_000);

test("a failed run opens its error and offers a way to retry the automation", async () => {
  await open("/automations/auto-dependency-audit");
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  await userEvent.click(
    runs.getByRole("button", { name: "Open the run Failed: npm registry timeout, retried once" }),
  );
  const detail = await screen.findByRole("region", {
    name: "Run details for Nightly dependency audit",
  });
  expect(within(detail).getByText("npm registry timeout, retried once")).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Run now" })).toBeTruthy();
});

test("file change automations require globs and save them from the create screen", async () => {
  const { app } = await open("/automations/new");
  await heading("New automation");
  await userEvent.type(field("Name"), "Watch tests");
  await userEvent.type(field("What should the agent do?"), "Review changed tests.");
  await choose("When it runs", "On file change");
  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));
  expect(await screen.findByText("Add at least one path.")).toBeTruthy();
  await userEvent.type(field("File globs, one per line"), "src/**/*.test.ts\npackages/**/*.ts");
  await userEvent.click(screen.getByRole("button", { name: "Create automation" }));
  await heading("Watch tests");
  const reply = await app.client.request({ type: "automation.list" });
  expect(
    reply.automations?.find((automation) => automation.title === "Watch tests")?.trigger,
  ).toEqual({ kind: "file", paths: ["src/**/*.test.ts", "packages/**/*.ts"] });
});

test("a trigger error shows a fix hint, survives a rename, and clears with retry or a new trigger", async () => {
  const { sidebar } = await open("/automations/auto-pr-review", (seed) => {
    seed.pollErrors = { "auto-pr-review": { at: Date.now(), message: "gh auth required: 401" } };
  });
  await heading("Review pull requests on open");
  const error = await main().findByRole("alert");
  expect(error.textContent).toContain("Trigger needs attention");
  expect(error.textContent).toContain("Sign in to GitHub on this machine");
  expect(error.textContent).not.toContain("401");
  expect(
    within(sidebar.getByRole("link", { name: /Review pull requests/ })).getByRole("img", {
      name: "Needs attention",
    }),
  ).toBeTruthy();
  expect(await main().findByRole("button", { name: "Retry trigger" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await heading("Edit automation");
  await userEvent.type(field("Name"), " fixed");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await heading("Review pull requests on open fixed");
  expect(main().getByRole("alert")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await heading("Edit automation");
  await choose("When it runs", "By hand");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await heading("Review pull requests on open fixed");
  expect(main().queryByRole("alert")).toBeNull();
});

test("a rarely run automation has its own history and older pages", async () => {
  await open("/automations/auto-changelog", (seed) => {
    seed.runs = Array.from({ length: 105 }, (_, index) => ({
      id: `history-${index}`,
      automationId: index < 53 ? "auto-changelog" : "auto-pr-review",
      title: index < 53 ? "Changelog draft" : "Review pull requests on open",
      eventKey: `history-${index}`,
      trigger: "manual",
      status: "succeeded",
      startedAt: index + 1,
      finishedAt: index + 2,
      result: `Result ${index}`,
    }));
  });
  await heading("Changelog draft");
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  expect(await runs.findByText("Result 52")).toBeTruthy();
  expect(runs.queryByText("Result 0")).toBeNull();
  expect(runs.queryByText("Result 104")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show older" }));
  expect(await runs.findByText("Result 0")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
});

test("run details show full output, link the produced thread and close back to the row", async () => {
  await open("/automations/auto-pr-review");
  await heading("Review pull requests on open");
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  const row = await runs.findByRole("button", { name: "Open the run #212 · approved with 1 note" });
  await userEvent.click(row);
  const detail = screen.getByRole("region", {
    name: "Run details for Review pull requests on open",
  });
  expect(within(detail).getByRole("region", { name: "Run output" }).textContent).toContain(
    "#212 · approved with 1 note",
  );
  expect(within(detail).getByRole("link", { name: "Open thread" }).getAttribute("href")).toBe(
    "/t/thread-bump-codex",
  );
  expect(within(detail).getAllByRole("button", { name: "Close" })).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(within(detail).getByRole("button", { name: "Close" }));
  expect(
    screen.queryByRole("region", { name: "Run details for Review pull requests on open" }),
  ).toBeNull();
  expect(document.activeElement).toBe(row);
});

test("a failed run shows its complete error even without a produced thread", async () => {
  await open("/automations/auto-flaky-triage", (seed) => {
    const run = seed.runs?.find((candidate) => candidate.automationId === "auto-flaky-triage");
    if (run) {
      run.status = "failed";
      run.result = "The test command failed.\nInstall the project dependencies and try again.";
    }
  });
  await heading("Flaky test triage");
  await userEvent.click(
    await screen.findByRole("button", { name: /Open the run Failed: The test command failed/ }),
  );
  const error = screen.getByRole("region", { name: "Run error" });
  expect(error.textContent).toContain("Install the project dependencies and try again.");
  expect(screen.queryByRole("link", { name: "Open thread" })).toBeNull();
});

test("the detail has one Edit entry point and keeps a selected time zone when reopened", async () => {
  await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await heading("Edit automation");
  await choose("Time zone", "Asia/Tokyo");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await heading("Nightly dependency audit");
  expect(main().getByText(/Every day at 02:00 \(Asia\/Tokyo\)/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await heading("Edit automation");
  expect(screen.getByRole("combobox", { name: "Time zone" }).textContent).toContain("Asia/Tokyo");
});

test("scheduled runs and the next run use the schedule's timezone without a repeated timestamp", async () => {
  await open("/automations/auto-dependency-audit", (seed) =>
    Object.assign(seed, workbenchServices(Date.now(), "Asia/Kolkata")),
  );
  await heading("Nightly dependency audit");
  const runs = within(await screen.findByRole("list", { name: "Recent runs" }));
  expect(runs.getAllByText(/2:00 AM/)).toHaveLength(4);
  await waitFor(() => expect(next()).toMatch(/2:00 AM.*Asia\/Kolkata/));
  await userEvent.click(
    runs.getByRole("button", { name: "Open the run 2 advisories · opened a thread in ace" }),
  );
  const details = await screen.findByRole("region", {
    name: "Run details for Nightly dependency audit",
  });
  expect(within(details).getByText("Scheduled · 4 min")).toBeTruthy();
  expect(within(details).queryByText(/\d+\/\d+\/\d{4}/)).toBeNull();
});

test("duplicating an automation opens a paused copy without running it", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
  await heading("Edit automation");
  expect(field("Name")).toHaveProperty("value", "Nightly dependency audit copy");
  const reply = await app.client.request({ type: "automation.list" });
  const copy = reply.automations?.find((entry) => entry.title === "Nightly dependency audit copy");
  expect(copy?.enabled).toBe(false);
  expect(copy?.prompt).toBe((await stored(app, "auto-dependency-audit"))?.prompt);
  expect((await stored(app, "auto-dependency-audit"))?.enabled).toBe(true);
});

test("Duplicate saves a paused copy of a maximum-length automation name before opening its editor", async () => {
  const title = "a".repeat(256);
  const { app } = await open("/automations/auto-dependency-audit", (seed) => {
    const automation = seed.automations?.find((entry) => entry.id === "auto-dependency-audit");
    if (!automation) throw new Error("Missing automation");
    automation.title = title;
  });
  const original = await stored(app, "auto-dependency-audit");
  if (!original) throw new Error("Missing automation");
  await heading(title);
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
  await heading("Edit automation");
  const reply = await app.client.request({ type: "automation.list" });
  const copy = reply.automations?.find(
    (entry) => entry.id !== original.id && entry.title.endsWith(" copy"),
  );
  expect(copy?.title).toHaveLength(256);
  expect(field("Name")).toHaveProperty("value", copy?.title);
  expect(copy?.enabled).toBe(false);
  expect(copy?.prompt).toBe(original.prompt);
  expect((await stored(app, original.id))?.title).toBe(title);
  expect((await stored(app, original.id))?.enabled).toBe(true);
});

test("the time field accepts evening times without losing exact minutes", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await heading("Edit automation");
  const time = screen.getByRole("textbox", { name: "At" });
  await userEvent.clear(time);
  await userEvent.type(time, "9:07 PM");
  await userEvent.tab();
  expect(time).toHaveProperty("value", "9:07 PM");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await heading("Nightly dependency audit");
  expect((await stored(app, "auto-dependency-audit"))?.trigger).toMatchObject({
    kind: "schedule",
    schedule: { expression: expect.stringContaining("BYHOUR=21;BYMINUTE=7") },
  });
});
