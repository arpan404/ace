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
function settledDaysAgo(days: number, keep?: "1d" | "3d") {
  let base = 0;
  const app = harness({ uiClock: () => base + days * day });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  base = settledAt(app);
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

test("a thread settled 2 days ago stays dimmed in its project with 3 days, not with 1 day", async () => {
  await openPanel(settledDaysAgo(2));
  const row = await within(threads()).findByRole("link", { name: bump });
  expect(row.getAttribute("aria-label")).toMatch(/^Bump Codex app-server to 0\.48\. Settled/);
  expect(within(row).getByText("Settled")).toBeTruthy();
});

test("with 1 day, a thread settled 2 days ago is only in History", async () => {
  await openPanel(settledDaysAgo(2, "1d"));
  await waitFor(() => expect(within(threads()).queryByRole("link", { name: bump })).toBeNull());
  // The foot counts it among History's threads.
  expect(screen.getByRole("link", { name: /^History/ }).textContent).toBe("History1");
});

test("History lists settled threads by week and filters by project", async () => {
  const app = settledDaysAgo(2, "1d");
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

test("a project's History opens prefiltered to that project", async () => {
  await openPanel(settledDaysAgo(2, "1d"));
  await userEvent.click(screen.getByRole("button", { name: "History of relay" }));
  const main = screen.getByRole("main");
  await within(main).findByRole("heading", { level: 2, name: "History" });
  expect(within(main).getByRole("button", { name: "relay" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(within(main).queryByRole("link", { name: bump })).toBeNull();
});
