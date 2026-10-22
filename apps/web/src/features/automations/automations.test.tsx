import { openProfileView } from "@/test/navigation.ts";
import { fakeClient } from "@/test/fake-client.ts";
import { chooseModel, openModelControl } from "@/test/model-control.ts";
import type { Client } from "@ace/client";
import { flakyCheckout, workbench, workbenchServices } from "@ace/fake-daemon";
import type { ClientMessage } from "@ace/protocol";
import { configure, act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

await import("../settings/agents-page.tsx");

type Seed = ReturnType<typeof workbenchServices>;
type RunRequest = Extract<ClientMessage, { type: "automation.run" }>;

/** Every automation.run the page sends, as it crosses to the daemon. */
function recordingRuns(client: Client, sent: RunRequest[]): Client {
  const request = client.request.bind(client);
  const recorded: typeof client.request = (input, options) => {
    if (input.type === "automation.run") sent.push(input as RunRequest);
    return request(input, options);
  };
  client.request = recorded;
  return client;
}

/** The design's daemon: its threads, then the automations and runs it holds. */
async function open(
  path: string,
  change?: (seed: Seed) => void,
  options: { storage?: ReturnType<typeof memoryKeyValue>; threads?: boolean } = {},
) {
  const runs: RunRequest[] = [];
  const app = harness({
    clock: () => Date.now(),
    storage: options.storage ?? localStorage,
    client: (daemon) => recordingRuns(fakeClient(daemon), runs),
  });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  // The thread an agent made "Re-run the checkout test overnight" from.
  if (options.threads) app.play(flakyCheckout()).runUntilBlocked();
  const seed = workbenchServices(Date.now(), "UTC");
  change?.(seed);
  app.daemon.seedServices(seed);
  await app.open(path);
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  const sidebar = within(await within(aside).findByRole("navigation", { name: "Automation list" }));
  await sidebar.findByText("Nightly dependency audit");
  return { app, sidebar, runs };
}

/** The daemon's copy of one of the person's automations. */
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

const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 2, name });
const main = () => within(screen.getByRole("main"));
const group = (sidebar: ReturnType<typeof within>, name: string) =>
  within(sidebar.getByRole("region", { name }));
const note = () => screen.findByRole("combobox", { name: "Note for this run" });
const prompt = () => screen.findByRole("combobox", { name: "What the agent does each time" });

async function menu(item: string) {
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

/** Open the strip's When popover and return it. */
async function when() {
  await userEvent.click(await screen.findByRole("button", { name: /^When: / }));
  return within(await screen.findByRole("dialog", { name: "When it runs" }));
}

async function choose(select: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

/** Runs of an automation the daemon holds, newest first. */
async function runsOf(app: ReturnType<typeof harness>, id: string) {
  const inbox = await app.client.request({ type: "automation.inbox", limit: 100 });
  return (inbox.inbox?.runs ?? []).filter((run) => run.automationId === id);
}

test("the list groups upcoming automations, then paused ones, each with when it runs next", async () => {
  const { sidebar } = await open("/automations/auto-dependency-audit");
  const upcoming = group(sidebar, "Upcoming");
  expect(
    upcoming
      .getAllByRole("link")
      .map((row) => row.querySelector("[data-view-row-title]")?.textContent)
      .toSorted(),
  ).toEqual(["Flaky test triage", "Nightly dependency audit", "Review pull requests on open"]);
  expect(upcoming.getByRole("link", { name: /Nightly dependency audit/ }).textContent).toMatch(
    /(Tonight|Tomorrow|Today) 2:00 AM · Every day$/,
  );
  expect(
    group(sidebar, "Paused").getByRole("link", { name: /Changelog draft/ }).textContent,
  ).toContain("Paused · ");
});

test("searching the list keeps only the automations whose names match", async () => {
  const { sidebar } = await open("/automations/auto-dependency-audit");
  await userEvent.click(screen.getByRole("button", { name: "Search automations" }));
  await userEvent.type(screen.getByRole("searchbox", { name: "Search automations" }), "flaky");
  await waitFor(() => expect(sidebar.queryByRole("link", { name: /Nightly/ })).toBeNull());
  expect(sidebar.getByRole("link", { name: /Flaky test triage/ })).toBeTruthy();
});

test("the sidebar list is one Tab stop that arrow keys move through", async () => {
  const { sidebar } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  const rows = group(sidebar, "Upcoming").getAllByRole("link");
  rows[0]?.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(rows[1]);
});

test("an automation whose last run failed says Failed on its row", async () => {
  const { sidebar } = await open("/automations", (seed) => {
    const latest = seed.runs?.find((run) => run.automationId === "auto-flaky-triage");
    if (latest) latest.status = "failed";
  });
  const flaky = sidebar.getByRole("link", { name: /Flaky test triage/ });
  expect(within(flaky).getByText("Failed")).toBeTruthy();
});

test("an automation reads as a conversation: its prompt once, then each run oldest first with its answer", async () => {
  await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  expect(main().getAllByText(/Audit dependencies in each project for advisories/)).toHaveLength(1);
  const runs = await screen.findAllByRole("article", { name: /^Run, / });
  expect(runs).toHaveLength(4);
  expect(runs[0]?.textContent).toContain("Failed");
  expect(runs[0]?.textContent).toContain("The npm registry timed out twice");
  const latest = runs.at(-1);
  if (!latest) throw new Error("No runs");
  // The turn's head says when and how long, and opens the run's own thread.
  const head = within(latest).getByRole("link", { name: /^Open run, / });
  expect(head.textContent).toContain("Worked for 12m");
  expect(head.getAttribute("href")).toBe("/t/thread-bump-codex");
  expect(await within(latest).findByText(/Found 2 advisories/)).toBeTruthy();
});

test("the header says when it runs next, or that automations are off on this machine", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await waitFor(() =>
    expect(main().getByRole("switch", { name: "Enabled" }).parentElement?.textContent).toMatch(
      /Tonight|Today|Tomorrow|Any moment/,
    ),
  );
  await setAutomations(app, false);
  expect(await main().findByRole("link", { name: "Turn on Run automations" })).toBeTruthy();
});

test("sending a note runs the automation now with that note, and the run appears as a working turn", async () => {
  const { app, runs } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  const before = (await runsOf(app, "auto-dependency-audit")).length;
  await userEvent.type(await note(), "Also check the lockfile{Enter}");
  expect(await main().findByText(/^Working for /)).toBeTruthy();
  expect(runs.at(-1)).toMatchObject({
    id: "auto-dependency-audit",
    message: "Also check the lockfile",
  });
  expect(await runsOf(app, "auto-dependency-audit")).toHaveLength(before + 1);
  expect(JSON.parse(localStorage.getItem("ace.automation.runIntents") ?? "[]")).toHaveLength(0);
});

test("Run now in the menu runs it without a note", async () => {
  const { app, runs } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  await menu("Run now");
  expect(await main().findByText(/^Working for /)).toBeTruthy();
  expect(runs.at(-1)?.message).toBeUndefined();
});

test("while automations are off nothing can be sent, and turning them on lets it run", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, false);
  await main().findByRole("link", { name: "Turn on Run automations" });
  await userEvent.type(await note(), "Check now");
  const send = screen.getByRole("button", { name: "Send" });
  expect(send.getAttribute("aria-disabled") === "true" || send.hasAttribute("disabled")).toBe(true);

  await userEvent.click(main().getByRole("link", { name: "Turn on Run automations" }));
  await userEvent.click(await screen.findByRole("switch", { name: "Run automations" }));
  await waitFor(() => expect(app.daemon.services.settings.get("automations.enabled")).toBe(true));
  await userEvent.click(screen.getByRole("link", { name: "Back to app" }));
  await openProfileView("Automations");
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  await userEvent.click(
    await within(aside).findByRole("link", { name: /Nightly dependency audit/ }),
  );
  await heading("Nightly dependency audit");
  await menu("Run now");
  expect(await main().findByText(/^Working for /)).toBeTruthy();
});

test("pausing from the switch moves it to Paused and stops runs; the switch resumes it", async () => {
  const { app, sidebar } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await userEvent.click(screen.getByRole("switch", { name: "Enabled" }));
  expect(
    await within(await sidebar.findByRole("region", { name: "Paused" })).findByRole("link", {
      name: /Nightly dependency audit/,
    }),
  ).toBeTruthy();
  expect(await main().findByText(/Paused\. Resume to schedule the next run\./)).toBeTruthy();
  await waitFor(async () =>
    expect((await stored(app, "auto-dependency-audit"))?.enabled).toBe(false),
  );
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(
    (await screen.findByRole("menuitem", { name: "Run now" })).getAttribute("aria-disabled"),
  ).toBe("true");
  await userEvent.keyboard("{Escape}");

  await userEvent.click(screen.getByRole("switch", { name: "Enabled" }));
  await waitFor(async () =>
    expect((await stored(app, "auto-dependency-audit"))?.enabled).toBe(true),
  );
  expect(
    await group(sidebar, "Upcoming").findByRole("link", { name: /Nightly dependency audit/ }),
  ).toBeTruthy();
});

test("a refused run says it didn't start, keeps its key and note, and Retry reuses both", async () => {
  const { app, runs } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  app.daemon.failRequests("automation.run");
  await userEvent.type(await note(), "Only the web app{Enter}");
  const alert = await main().findByRole("alert", { name: "Run now" });
  expect(alert.textContent).toContain("Not started");
  const kept = JSON.parse(localStorage.getItem("ace.automation.runIntents") ?? "[]");
  expect(kept).toHaveLength(1);
  expect(kept[0].message).toBe("Only the web app");
  app.daemon.restoreRequests();
  await userEvent.click(within(alert).getByRole("button", { name: "Retry run" }));
  expect(await main().findByText(/^Working for /)).toBeTruthy();
  expect(runs.at(-1)?.message).toBe("Only the web app");
  expect(JSON.parse(localStorage.getItem("ace.automation.runIntents") ?? "[]")).toHaveLength(0);
  const inbox = await runsOf(app, "auto-dependency-audit");
  expect(inbox.filter((run) => run.id === `run-${kept[0].requestId}`)).toHaveLength(1);
});

test("a lost acknowledgement still retries to the same admitted run after reopening", async () => {
  const { app, sidebar } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  app.daemon.failRequests("automation.run");
  await menu("Run now");
  expect(await main().findByRole("button", { name: "Retry run" })).toBeTruthy();
  const requestId = JSON.parse(localStorage.getItem("ace.automation.runIntents") ?? "[]")[0]
    .requestId as string;
  app.daemon.restoreRequests();
  await app.client.request(
    { type: "automation.run", id: "auto-dependency-audit", variables: {} },
    { requestId },
  );
  await userEvent.click(sidebar.getByRole("link", { name: /Review pull requests/ }));
  await heading("Review pull requests on open");
  await userEvent.click(sidebar.getByRole("link", { name: /Nightly dependency audit/ }));
  await heading("Nightly dependency audit");
  await userEvent.click(await main().findByRole("button", { name: "Retry run" }));
  await waitFor(() => expect(main().queryByRole("button", { name: "Retry run" })).toBeNull());
  const inbox = await runsOf(app, "auto-dependency-audit");
  expect(inbox.filter((run) => run.id === `run-${requestId}`)).toHaveLength(1);
});

test("a run is refused when this browser can only remember its retry key in memory", async () => {
  const { app } = await open("/automations/auto-dependency-audit", undefined, {
    storage: { ...memoryKeyValue(), durable: false },
  });
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  const before = await runsOf(app, "auto-dependency-audit");
  await menu("Run now");
  expect((await main().findByRole("alert", { name: "Run now" })).textContent).toContain(
    "Couldn't save the run request",
  );
  expect(await runsOf(app, "auto-dependency-audit")).toHaveLength(before.length);
});

test("a second send while the first run is starting doesn't dispatch another run", async () => {
  const { app, runs } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  app.daemon.holdRequests("automation.run");
  try {
    await userEvent.type(await note(), "First{Enter}");
    await waitFor(() => expect(runs).toHaveLength(1));
    await userEvent.type(await note(), "Second{Enter}");
    expect((await note()).textContent).toContain("Second");
    expect(runs).toHaveLength(1);
  } finally {
    app.daemon.restoreRequests();
  }
});

test("a failed run says what happened, and Run again starts it", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await setAutomations(app, true);
  const failed = (await screen.findAllByRole("article", { name: /^Run, / }))[0];
  if (!failed) throw new Error("No runs");
  expect(failed.textContent).toContain("The npm registry timed out twice");
  await userEvent.click(within(failed).getByRole("button", { name: "Run again" }));
  expect(await main().findByText(/^Working for /)).toBeTruthy();
});

test("changing the model chip's effort saves the automation", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  const popover = await openModelControl();
  const effort = within(popover).getByRole("slider", { name: "Effort" });
  effort.focus();
  await userEvent.keyboard("{ArrowLeft}");
  await userEvent.keyboard("{Escape}");
  await waitFor(async () =>
    expect((await stored(app, "auto-dependency-audit"))?.effort).not.toBe("high"),
  );
  expect((await stored(app, "auto-dependency-audit"))?.instance).toBe("claude-work");
});

test("a model change made over a stale copy reports the conflict instead of overwriting", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  const automation = await stored(app, "auto-dependency-audit");
  if (!automation) throw new Error("Missing automation");
  await app.client.request({
    type: "automation.put",
    automation: { ...automation, prompt: `${automation.prompt} Elsewhere.` },
  });
  await chooseModel("GPT-5 Codex", "Codex");
  expect(await screen.findAllByText(/changed elsewhere.*Reload/i)).not.toHaveLength(0);
  const saved = await stored(app, "auto-dependency-audit");
  expect(saved?.prompt).toContain("Elsewhere.");
  expect(saved?.provider).toBe("claude");
}, 20_000);

test("a new automation is named from its prompt, runs when chosen and opens once created", async () => {
  const { app } = await open("/automations");
  await userEvent.click(screen.getByRole("link", { name: "New automation" }));
  expect(await screen.findByText(/What should run on its own in/)).toBeTruthy();
  const popover = await when();
  await choose("Runs", "On a schedule");
  await choose("Repeat", "Weekdays");
  expect(popover.getByText(/^Next: /)).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.type(
    await prompt(),
    "Summarise last night's CI failures. Then open a thread for each.{Enter}",
  );
  await heading("Summarise last night's CI failures");
  expect(main().getByText(/^Weekdays at 9:00 AM/)).toBeTruthy();
  const saved = (await app.client.request({ type: "automation.list" })).automations?.find(
    (automation) => automation.title === "Summarise last night's CI failures",
  );
  expect(saved?.prompt).toBe("Summarise last night's CI failures. Then open a thread for each.");
  expect(saved?.enabled).toBe(true);
});

test("a repeating automation can start at a later day and time, on its first run from then", async () => {
  const { app } = await open("/automations/new");
  const popover = await when();
  await choose("Repeat", "Every day");
  await userEvent.click(popover.getByRole("button", { name: "Starts: Now" }));
  // The calendar opens on today: two weeks on, then 10:30 AM, after that day's 9:00 AM run.
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  await userEvent.click(await screen.findByRole("button", { name: /^Time: / }));
  await userEvent.click(
    within(screen.getByRole("listbox", { name: "Hour" })).getByRole("option", { name: "10" }),
  );
  await userEvent.click(
    within(screen.getByRole("listbox", { name: "Minute" })).getByRole("option", { name: "30" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "AM" }));
  await userEvent.keyboard("{Escape}");
  expect(popover.getByRole("button", { name: /^Starts: .*10:30 AM/ })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: /^When: / }).textContent).toMatch(
    /^Every day at 9:00 AM from /,
  );
  await userEvent.type(await prompt(), "Later start{Enter}");
  await heading("Later start");
  const saved = (await app.client.request({ type: "automation.list" })).automations?.find(
    (automation) => automation.title === "Later start",
  );
  const startAt = saved?.trigger.kind === "schedule" ? saved.trigger.schedule.startAt : 0;
  const start = new Date(startAt);
  expect([start.getHours(), start.getMinutes()]).toEqual([9, 0]);
  expect(startAt).toBeGreaterThan(Date.now() + 14 * 86_400_000);
});

test("an idea fills the prompt and when it runs", async () => {
  await open("/automations/new");
  await userEvent.click(
    await screen.findByRole("button", { name: /Draft release notes from the pull requests/ }),
  );
  expect((await prompt()).textContent).toContain("Draft release notes");
  expect(screen.getByRole("button", { name: /^When: / }).textContent).toContain(
    "Fridays at 4:00 PM",
  );
});

test("an invalid custom RRULE is caught in the When popover and nothing is created", async () => {
  const { app } = await open("/automations/new");
  const popover = await when();
  await choose("Repeat", "Custom");
  await userEvent.type(popover.getByRole("textbox", { name: "Expression" }), "FREQ=BOGUS");
  await userEvent.keyboard("{Escape}");
  const before = (await app.client.request({ type: "automation.list" })).automations?.length;
  await userEvent.type(await prompt(), "Nothing much{Enter}");
  expect(await screen.findByText(/valid RRULE/i)).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "When it runs" })).toBeTruthy();
  expect((await app.client.request({ type: "automation.list" })).automations).toHaveLength(
    before ?? 0,
  );
});

test("a valid custom RRULE is created and reads back", async () => {
  await open("/automations/new");
  const popover = await when();
  await choose("Repeat", "Custom");
  await userEvent.type(
    popover.getByRole("textbox", { name: "Expression" }),
    "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=30",
  );
  await userEvent.keyboard("{Escape}");
  await userEvent.type(await prompt(), "Monday sweep{Enter}");
  await heading("Monday sweep");
  expect(main().getByText(/^Mondays at 8:30 AM/)).toBeTruthy();
});

test("a GitHub trigger needs an owner/name repository", async () => {
  await open("/automations/new");
  const popover = await when();
  await choose("Runs", "On pull requests or issues");
  await userEvent.type(popover.getByRole("textbox", { name: "Repository" }), "not a repo");
  expect(await popover.findByText("Use owner/name, like arpan404/ace.")).toBeTruthy();
  await userEvent.clear(popover.getByRole("textbox", { name: "Repository" }));
  await userEvent.type(popover.getByRole("textbox", { name: "Repository" }), "arpan404/ace");
  await userEvent.keyboard("{Escape}");
  await userEvent.type(await prompt(), "Review each pull request{Enter}");
  await heading("Review each pull request");
});

test("a file change automation needs globs and saves them", async () => {
  const { app } = await open("/automations/new");
  await when();
  await choose("Runs", "When files change");
  await userEvent.keyboard("{Escape}");
  await userEvent.type(await prompt(), "Review changed tests{Enter}");
  const reopened = within(await screen.findByRole("dialog", { name: "When it runs" }));
  expect(reopened.getByText("Add at least one path.")).toBeTruthy();
  await userEvent.type(
    reopened.getByRole("textbox", { name: "Files, one glob per line" }),
    "src/**/*.test.ts",
  );
  await userEvent.keyboard("{Escape}");
  await userEvent.type(await prompt(), "{Enter}");
  await heading("Review changed tests");
  const saved = (await app.client.request({ type: "automation.list" })).automations?.find(
    (automation) => automation.title === "Review changed tests",
  );
  expect(saved?.trigger).toEqual({ kind: "file", paths: ["src/**/*.test.ts"] });
});

test("a model picked in the chip is saved as the provider's model id", async () => {
  const { app } = await open("/automations/new");
  await chooseModel("GPT-5 Codex", "Codex");
  await userEvent.type(await prompt(), "Reply QA_AUTOMATION_OK{Enter}");
  await heading("Reply QA_AUTOMATION_OK");
  const saved = (await app.client.request({ type: "automation.list" })).automations?.find(
    (automation) => automation.title === "Reply QA_AUTOMATION_OK",
  );
  expect(saved).toMatchObject({ provider: "codex", model: "gpt-5-codex" });
}, 20_000);

test("Edit when changes the schedule in place, and the new schedule reads everywhere", async () => {
  const { app, sidebar } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  await menu("Edit when");
  await screen.findByRole("dialog", { name: "When it runs" });
  // Still the conversation, with its runs: nothing navigated away.
  expect(screen.getByRole("group", { name: "Prompt" })).toBeTruthy();
  await choose("Repeat", "Weekly");
  await choose("Day", "Monday");
  await userEvent.click(screen.getByRole("button", { name: /^At: / }));
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Exact time" }),
    "9:07 PM{Enter}",
  );
  await userEvent.keyboard("{Escape}");
  expect(await main().findByText(/^Mondays at 9:07 PM/)).toBeTruthy();
  expect((await sidebar.findByRole("link", { name: /Flaky test triage/ })).textContent).toContain(
    "Mondays",
  );
  expect((await stored(app, "auto-flaky-triage"))?.trigger).toMatchObject({
    schedule: { expression: expect.stringContaining("BYHOUR=21;BYMINUTE=7") },
  });
});

test("the prompt edits in its own bubble and saves", async () => {
  const { app } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const box = screen.getByRole("textbox", { name: "Prompt" });
  await userEvent.type(box, " Also on Windows.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("group", { name: "Prompt" })).textContent).toMatch(
    /Also on Windows\.$/,
  );
  await waitFor(async () =>
    expect((await stored(app, "auto-flaky-triage"))?.prompt).toMatch(/Also on Windows\.$/),
  );
});

test("Escape puts the prompt back as it was", async () => {
  await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  await menu("Edit prompt");
  await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), " Never mind.{Escape}");
  expect((await screen.findByRole("group", { name: "Prompt" })).textContent).not.toContain(
    "Never mind.",
  );
});

test("a prompt edit over a stale copy reports the conflict instead of overwriting", async () => {
  const { app } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  const automation = await stored(app, "auto-flaky-triage");
  if (!automation) throw new Error("Missing automation");
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await app.client.request({
    type: "automation.put",
    automation: { ...automation, prompt: `${automation.prompt} Elsewhere.` },
  });
  await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), " Also on Windows.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findAllByText(/changed elsewhere/i)).not.toHaveLength(0);
  expect((await stored(app, "auto-flaky-triage"))?.prompt).toContain("Elsewhere.");
});

test("an old link to the edit page lands on the automation", async () => {
  await open("/automations/auto-flaky-triage/edit");
  await heading("Flaky test triage");
  expect(await screen.findByRole("group", { name: "Prompt" })).toBeTruthy();
  expect(screen.queryByText(/What should run on its own/)).toBeNull();
});

test("renaming from the menu saves the new name", async () => {
  const { app } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  await menu("Rename");
  const name = await screen.findByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Flake hunt{Enter}");
  await heading("Flake hunt");
  expect((await stored(app, "auto-flaky-triage"))?.title).toBe("Flake hunt");
});

test("deleting an automation removes it at once, and Undo recreates it with its runs", async () => {
  const { app, sidebar } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  await menu("Delete");
  await waitFor(() =>
    expect(sidebar.queryByRole("link", { name: /Flaky test triage/ })).toBeNull(),
  );
  expect(await stored(app, "auto-flaky-triage")).toBeUndefined();
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await userEvent.click(await sidebar.findByRole("link", { name: /Flaky test triage/ }));
  await heading("Flaky test triage");
  expect(await main().findByText(/1,284 tests passed every time/)).toBeTruthy();
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
  await menu("Delete");
  expect(await screen.findAllByText(/changed elsewhere.*before deleting/i)).not.toHaveLength(0);
  expect(await sidebar.findByRole("link", { name: /Flaky test triage/ })).toBeTruthy();
  expect(screen.queryByText(/Deleted · Flaky test triage/)).toBeNull();
});

test("a committed delete offers Undo while the list refresh is unavailable", async () => {
  const { app } = await open("/automations/auto-flaky-triage");
  await heading("Flaky test triage");
  app.daemon.holdRequests("automation.list");
  try {
    await menu("Delete");
    expect(await screen.findByText("Deleted · Flaky test triage")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  } finally {
    app.daemon.restoreRequests();
  }
  expect(await stored(app, "auto-flaky-triage")).toBeUndefined();
});

test("offline, the switch can't claim an enabled automation stopped", async () => {
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

test("a trigger that stopped says why in words, and Retry clears it", async () => {
  const { sidebar } = await open("/automations/auto-pr-review", (seed) => {
    seed.pollErrors = { "auto-pr-review": { at: Date.now(), message: "gh auth required: 401" } };
  });
  await heading("Review pull requests on open");
  const alert = await main().findByRole("alert", { name: "Trigger" });
  expect(alert.textContent).toContain("Not watching");
  expect(alert.textContent).toContain("Sign in to GitHub on this machine");
  expect(alert.textContent).not.toContain("401");
  expect(
    within(sidebar.getByRole("link", { name: /Review pull requests/ })).getByText("Not watching"),
  ).toBeTruthy();
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(main().queryByRole("alert", { name: "Trigger" })).toBeNull());
});

test("a rarely run automation shows its own runs and older pages on demand", async () => {
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
  expect(await main().findByText("Result 52")).toBeTruthy();
  expect(main().queryByText("Result 0")).toBeNull();
  expect(main().queryByText("Result 104")).toBeNull();
  await userEvent.click(main().getByRole("button", { name: "Show older runs" }));
  expect(await main().findByText("Result 0")).toBeTruthy();
  expect(main().queryByRole("button", { name: "Show older runs" })).toBeNull();
});

test("an agent's automation opens as the same conversation, runs and pauses through its thread", async () => {
  const { app, sidebar, runs } = await open("/automations/auto-dependency-audit", undefined, {
    threads: true,
  });
  await setAutomations(app, true);
  const row = await within(await sidebar.findByRole("region", { name: "In threads" })).findByRole(
    "link",
    { name: /Re-run the checkout test overnight/ },
  );
  await userEvent.click(row);
  await heading("Re-run the checkout test overnight");
  // Its page links back to the thread it belongs to.
  expect(
    (await main().findByRole("link", { name: "Fix flaky checkout test" })).getAttribute("href"),
  ).toBe("/t/thread-checkout");
  expect(await main().findByText(/25 of 25 runs passed/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Model: / })).toBeNull();
  await userEvent.type(await note(), "Seed 81733 first{Enter}");
  await waitFor(() =>
    expect(runs.at(-1)).toMatchObject({ id: "agent-checkout-soak", source: "thread" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("switch", { name: "Enabled" }));
  await waitFor(async () => {
    const reply = await app.client.request({ type: "automation.list", includeThreads: true });
    expect(
      reply.threadAutomations?.find((entry) => entry.automation.id === "agent-checkout-soak")
        ?.automation.enabled,
    ).toBe(false);
  });
});

test("duplicating opens a paused copy without running it", async () => {
  const { app } = await open("/automations/auto-dependency-audit");
  await heading("Nightly dependency audit");
  await menu("Duplicate");
  await heading("Nightly dependency audit copy");
  expect(main().getByRole("group", { name: "Prompt" }).textContent).toContain("Audit dependencies");
  const copy = (await app.client.request({ type: "automation.list" })).automations?.find(
    (entry) => entry.title === "Nightly dependency audit copy",
  );
  expect(copy?.enabled).toBe(false);
  expect((await stored(app, "auto-dependency-audit"))?.enabled).toBe(true);
});

test("Automations opens on the first automation rather than an empty pane", async () => {
  await open("/automations");
  expect(await heading("Nightly dependency audit")).toBeTruthy();
});

test("when the daemon can't list automations, the view says so once, with a retry", async () => {
  const app = harness();
  app.daemon.failRequests("automation.list");
  await app.open("/automations");
  const aside = within(await screen.findByRole("complementary", { name: "Automations" }));
  expect(await main().findByText("Automations unavailable", {}, { timeout: 4000 })).toBeTruthy();
  expect(aside.getByText("Couldn't load the list.")).toBeTruthy();
  app.daemon.restoreRequests();
  await userEvent.click(main().getByRole("button", { name: "Try again" }));
  expect(await main().findByText("No automations yet")).toBeTruthy();
  expect(await main().findByRole("link", { name: "New automation" })).toBeTruthy();
});

test("while the list loads, the sidebar shows it loading", async () => {
  const app = harness();
  app.daemon.holdRequests("automation.list");
  await app.open("/automations");
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  expect(await within(aside).findByRole("status", { name: "Loading automations" })).toBeTruthy();
});

test("on a phone, Automations opens on its list rather than the first automation", async () => {
  const original = globalThis.matchMedia;
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
    expect(main().getByRole("link", { name: /Nightly dependency audit/ })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 2, name: "Nightly dependency audit" }),
    ).toBeNull();
  } finally {
    globalThis.matchMedia = original;
  }
});
