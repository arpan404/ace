import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const day = 24 * 60 * 60 * 1000;
const threads = () => screen.getByRole("navigation", { name: "Threads" });
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
  await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole("link", {
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
  expect(await within(main).findByRole("heading", { level: 2, name: "History" })).toBeTruthy();
  const week = await within(main).findByRole("region", { name: "This week" });
  const row = await within(week).findByRole("link", { name: bump });
  // Its PR and branch show on the row.
  await waitFor(() => expect(row.textContent).toContain("#212"));
  expect(row.textContent).toContain("chore/codex-048");
  // The rail keeps Threads current while History is open.
  expect(screen.getByRole("link", { name: "Threads" }).getAttribute("aria-current")).toBe("page");

  await userEvent.click(within(main).getByRole("button", { name: "relay" }));
  await waitFor(() => expect(within(main).queryByRole("link", { name: bump })).toBeNull());
  expect(within(main).getByText("No settled threads in relay.")).toBeTruthy();
  await userEvent.click(within(main).getByRole("button", { name: "ace" }));
  expect(await within(main).findByRole("link", { name: bump })).toBeTruthy();
  await userEvent.click(within(main).getByRole("button", { name: "All projects" }));
  expect(await within(main).findByRole("link", { name: bump })).toBeTruthy();
});
