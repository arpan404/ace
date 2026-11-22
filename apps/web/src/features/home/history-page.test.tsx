import { chats, workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { listGroup } from "@/test/list-groups.ts";

configure({ asyncUtilTimeout: 10000 });

const day = 24 * 60 * 60 * 1000;
const threads = () => screen.getByRole("navigation", { name: "Projects" });
const bump = /^Bump Codex app-server to 0\.48/;

/**
 * The workbench, seen from a device whose clock reads `days` after the daemon settled the Codex
 * bump (its merged PR settled it as the scenario ended).
 */
function settledDaysAgo(days: number, keep?: "1d") {
  let base = 0;
  const app = harness({ uiClock: () => base + days * day });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  base = settledAt(app);
  // A setting the panel no longer reads (ADR 0107), as a settings file may still hold it.
  if (keep) app.daemon.services.settings.seed({ "threads.keepSettledFor": keep });
  return app;
}

function settledAt(app: ReturnType<typeof harness>): number {
  const view = app.daemon.snapshot({ kind: "threads" });
  const at = view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
  return at ?? 0;
}

async function openPanel(app: ReturnType<typeof harness>, path = "/new") {
  await app.open(path);
  await within(await screen.findByRole("navigation", { name: "Projects" })).findByRole("link", {
    name: /^Dedupe thread events/,
  });
}

test("a thread settled long ago stays in the Settled tab, whatever the old grace setting says", async () => {
  await openPanel(settledDaysAgo(30, "1d"));
  const nav = within(threads());
  // The Inbox holds the running thread, never the long-settled bump.
  expect(nav.queryByRole("link", { name: bump })).toBeNull();
  await userEvent.click(nav.getByRole("tab", { name: /^Settled/ }));
  expect(await nav.findByRole("link", { name: bump })).toBeTruthy();
  expect(nav.queryByRole("link", { name: /^Dedupe thread events/ })).toBeNull();
});

test("Settings no longer offers a grace period for settled threads", async () => {
  const app = settledDaysAgo(2);
  await app.open("/settings/agents");
  // The thread list's settings are there; the grace period is not.
  expect(await screen.findByText("Sort threads")).toBeTruthy();
  expect(screen.queryByText("Keep settled threads in their project")).toBeNull();
});

test("History lists settled threads by week and filters by project", async () => {
  const app = settledDaysAgo(2);
  await openPanel(app, "/history");
  const main = screen.getByRole("main");
  expect(await screen.findByRole("heading", { level: 1, name: "History" })).toBeTruthy();
  const list = await within(main).findByRole("list", { name: "Settled threads" });
  const row = await listGroup(list, "This week").findByRole("link", { name: bump });
  // Its PR and branch show on the row.
  await waitFor(() => expect(row.textContent).toContain("#212"));
  expect(row.textContent).toContain("chore/codex-048");
  // The rail keeps Threads current while History is open.
  expect(screen.getByRole("link", { name: "Projects" }).getAttribute("aria-current")).toBe("page");

  await chooseProject(main, "relay");
  await waitFor(() => expect(within(main).queryByRole("link", { name: bump })).toBeNull());
  expect(within(main).getByText("No settled threads in relay.")).toBeTruthy();
  await chooseProject(main, "ace");
  expect(await within(main).findByRole("link", { name: bump })).toBeTruthy();
  await chooseProject(main, "All projects");
  expect(await within(main).findByRole("link", { name: bump })).toBeTruthy();
});

test("History folds every chat's own project into one Chats choice", async () => {
  const app = settledDaysAgo(2);
  for (const chat of chats()) app.play(chat.scenario).runUntilBlocked();
  await openPanel(app, "/history");
  const main = screen.getByRole("main");
  await within(main).findByRole("link", { name: bump });
  await userEvent.click(within(main).getByRole("button", { name: /^Project: / }));
  const choices = (await screen.findAllByRole("menuitemradio")).map(
    (choice) => choice.textContent ?? "",
  );
  expect(choices.filter((choice) => /^Chats/.test(choice))).toHaveLength(1);
  expect(choices.some((choice) => /^Chat[^s]/.test(choice))).toBe(false);
  await userEvent.click(screen.getByRole("menuitemradio", { name: /Chats\s*\d*$/ }));
  expect(await within(main).findByText("No settled chats yet.")).toBeTruthy();
});

/** Picks a project from History's one project menu. */
async function chooseProject(main: HTMLElement, name: string) {
  // Picking a project leaves the radio menu open for the next choice.
  if (screen.queryAllByRole("menuitemradio").length === 0) {
    await userEvent.click(within(main).getByRole("button", { name: /^Project: / }));
  }
  // A project's mark puts its initials before the name in the row's text.
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: new RegExp(`${name}\\s*\\d*$`) }),
  );
}
